// SOC コンソールが使う SPL。
//
// 実データが無い環境でも必ず絵が出るよう makeresults で自己完結させてある。
// 実運用では中身を差し替える（返す列名さえ合っていれば描画側はそのまま動く）。
// 列の対応表は README を参照。

/**
 * アラート一覧。この画面の主役。
 *
 * 返す列: id, time(エポック秒), severity, status, rule, entity, src_ip, dest_ip,
 *         technique, tactic, score, owner
 *
 * ⚠ 時刻は strftime で文字列化しない（サーバ TZ で解釈されてブラウザの時計とズレる）。
 */
export const SPL_ALERTS = `| makeresults count=28
| streamstats count AS n
| eval id = "ALT-" . tostring(100000 + n*137)
| eval time = now() - (n * 420) - (random()%300)
| eval sevpick = (n * 7) % 10
| eval severity = case(sevpick<2,"critical", sevpick<5,"high", sevpick<8,"medium", true(),"low")
| eval status = case(n%9==0,"contained", n%5==0,"investigating", n%11==0,"closed", true(),"new")
| eval rulepick = n % 8
| eval rule = case(
    rulepick==0, "Credential Dumping via LSASS Access",
    rulepick==1, "Suspicious PowerShell Encoded Command",
    rulepick==2, "Beaconing to Known C2 Infrastructure",
    rulepick==3, "Impossible Travel Detected",
    rulepick==4, "Mass File Encryption Behavior",
    rulepick==5, "Privilege Escalation via Token Manipulation",
    rulepick==6, "Anomalous Outbound Data Transfer",
    true(), "Brute Force Authentication Attempts")
| eval technique = case(
    rulepick==0, "T1003.001", rulepick==1, "T1059.001", rulepick==2, "T1071.001",
    rulepick==3, "T1078", rulepick==4, "T1486", rulepick==5, "T1134",
    rulepick==6, "T1041", true(), "T1110")
| eval tactic = case(
    rulepick==0, "Credential Access", rulepick==1, "Execution", rulepick==2, "Command and Control",
    rulepick==3, "Initial Access", rulepick==4, "Impact", rulepick==5, "Privilege Escalation",
    rulepick==6, "Exfiltration", true(), "Credential Access")
| eval entity = case(n%6==0,"WIN-DC01", n%6==1,"SRV-APP03", n%6==2,"WKS-8842",
                     n%6==3,"LNX-DB02", n%6==4,"SRV-FILE01", true(),"WKS-3310")
| eval src_ip = "10.14." . tostring(n%250) . "." . tostring((n*13)%250)
| eval dest_ip = if(rulepick==2 OR rulepick==6, "185.243." . tostring((n*7)%250) . "." . tostring((n*3)%250), "10.20." . tostring(n%250) . "." . tostring((n*5)%250))
| eval score = case(severity=="critical", 80+(random()%20), severity=="high", 60+(random()%20),
                    severity=="medium", 35+(random()%25), true(), 10+(random()%25))
| eval owner = case(status=="new","—", n%4==0,"a.tanaka", n%4==1,"m.suzuki", n%4==2,"k.yamada", true(),"r.sato")
| table id time severity status rule entity src_ip dest_ip technique tactic score owner`;

/** 上部 KPI。件数・MTTD/MTTR・オープン数など。 */
export const SPL_KPI = `| makeresults count=1
| eval new_count = 47, investigating = 12, critical_open = 3, mttr_min = 38, mttd_min = 11, closed_today = 64
| table new_count investigating critical_open mttr_min mttd_min closed_today`;

/** 24 時間のアラート発生推移（severity 別に積む）。 */
export const SPL_TREND = `| makeresults count=24
| streamstats count AS h
| eval hour = h - 1
| eval critical = round(1 + 2*sin(h/3.0) + (random()%3))
| eval high     = round(4 + 3*sin(h/4.0+1) + (random()%5))
| eval medium   = round(8 + 5*sin(h/5.0+2) + (random()%7))
| eval low      = round(12 + 6*sin(h/6.0) + (random()%9))
| table hour critical high medium low`;

/** MITRE ATT&CK 戦術別の検知数。 */
export const SPL_TACTICS = `| makeresults count=1
| eval raw="Initial Access 18,Execution 31,Persistence 12,Privilege Escalation 22,Defense Evasion 27,Credential Access 34,Discovery 15,Lateral Movement 19,Collection 9,Command and Control 25,Exfiltration 7,Impact 5"
| makemv delim="," raw
| mvexpand raw
| rex field=raw "(?<tactic>.+)\\s(?<count>\\d+)$"
| eval count=tonumber(count)
| table tactic count`;

/** 上位の影響資産。 */
export const SPL_ENTITIES = `| makeresults count=1
| eval raw="WIN-DC01 critical 24,SRV-APP03 high 19,LNX-DB02 high 16,WKS-8842 medium 13,SRV-FILE01 medium 11,WKS-3310 low 8"
| makemv delim="," raw
| mvexpand raw
| rex field=raw "(?<entity>\\S+)\\s(?<severity>\\S+)\\s(?<count>\\d+)"
| eval count=tonumber(count)
| table entity severity count`;

/**
 * 選択したアラートの関連イベント（タイムライン）。
 *
 * ⚠ entity をそのまま SPL に埋め込むので、呼び出し側で必ずサニタイズする
 *   （searches.js は文字列を組み立てるだけ。検証は buildTimelineSPL で行う）。
 */
export function buildTimelineSPL(entity) {
    // 英数字・ハイフン・アンダースコア・ドットのみ許可する。
    // 想定外の文字が来たら空にして、SPL を壊さない＆注入させない。
    const safe = String(entity || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64);
    const host = safe || 'UNKNOWN';
    return `| makeresults count=9
| streamstats count AS n
| eval host = "${host}"
| eval time = now() - (n * 180) - (random()%120)
| eval stage = case(n<=2,"detection", n<=4,"enrichment", n<=6,"correlation", true(),"context")
| eval action = case(
    n==1, "Rule fired on " . host,
    n==2, "Process spawned: powershell.exe -enc <base64>",
    n==3, "Parent process: winword.exe (suspicious lineage)",
    n==4, "Threat intel match: hash seen in 3 prior campaigns",
    n==5, "Outbound connection to 185.243.x.x:443",
    n==6, "Correlated with 4 alerts on same subnet",
    n==7, "Asset criticality: HIGH (domain controller)",
    n==8, "User context: svc_backup (privileged)",
    true(), "Last known good baseline: 14d ago")
| table time stage action`;
}
