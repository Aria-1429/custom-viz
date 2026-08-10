// 各セクションが使う SPL。
//
// 実データが無い環境でも必ず絵が出るよう makeresults で自己完結させてある。
// 実運用では中身を自分のインデックスを引くサーチに差し替える
// （返す列名さえ合っていれば描画側はそのまま動く）。

/** 概況 KPI：4 つの指標＋それぞれのスパークライン用の系列。 */
export const SPL_KPI = `| makeresults count=40
| streamstats count AS t
| eval events   = round(24000 + 9000*sin(t/5.0) + (random()%3200))
| eval alerts   = round(40 + 26*sin(t/3.5+1) + (random()%22))
| eval latency  = round(120 + 48*sin(t/6.0+2) + (random()%38))
| eval hosts    = round(420 + 16*sin(t/8.0) + (random()%12))
| table t events alerts latency hosts`;

/** 上位ホスト：横棒に使う。severity で色が変わる。 */
export const SPL_HOSTS = `| makeresults count=1
| eval raw="web-01 critical 1842,db-02 critical 1610,api-03 high 1284,cache-04 high 1103,lb-05 medium 861,worker-06 medium 742,queue-07 low 603,edge-08 low 488"
| makemv delim="," raw
| mvexpand raw
| rex field=raw "(?<host>\\S+)\\s(?<severity>\\S+)\\s(?<count>\\d+)"
| eval count=tonumber(count)
| table host severity count
| sort - count`;

/** サービス別スコア：レーダーチャートに使う。 */
export const SPL_SERVICES = `| makeresults count=1
| eval raw="AUTH 92,PAYMENT 78,SEARCH 88,STORAGE 64,STREAM 81,GATEWAY 95,INDEX 72"
| makemv delim="," raw
| mvexpand raw
| rex field=raw "(?<service>\\S+)\\s(?<score>\\d+)"
| eval score=tonumber(score)
| table service score`;

/** 時間帯別の件数：縦棒に使う。 */
export const SPL_TIMELINE = `| makeresults count=36
| streamstats count AS slot
| eval count = 300 + 260*sin(slot/4.0) + (random()%180)
| eval label = "T-" . tostring(36 - slot)
| table label count`;

/** リソース使用率：円環ゲージ 4 つ。0〜100 の値を返す。 */
export const SPL_RESOURCES = `| makeresults count=1
| eval raw="CPU 68,MEMORY 74,DISK 41,NETWORK 57"
| makemv delim="," raw
| mvexpand raw
| rex field=raw "(?<metric>\\S+)\\s(?<pct>\\d+)"
| eval pct=tonumber(pct)
| table metric pct`;

/** ライブログ：流れる行。時刻・severity・メッセージを返す。 */
export const SPL_STREAM = `| makeresults count=14
| streamstats count AS n
| eval severity = case(n%7==0,"critical", n%5==0,"high", n%3==0,"medium", true(),"low")
| eval msg = case(
    n%7==0, "authentication failure burst detected on edge gateway",
    n%5==0, "replication lag exceeded threshold on shard-" . tostring(n),
    n%3==0, "elevated p99 latency observed in payment pipeline",
    true(), "health probe ok / node-" . tostring(n) . " responding")
| eval epoch = now() - (n*7)
| table epoch severity msg`;
// ⚠ 時刻は strftime で文字列にしない。
//   strftime は Splunk サーバのタイムゾーンで解釈されるため、
//   ブラウザ側で描く時計と数時間ズレて表示される（実機で発生）。
//   エポック秒のまま返して、描画側で toLocaleTimeString する。
