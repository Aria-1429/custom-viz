import json, io

P='Splunk-Dashboard-Examples/server_infra_monitoring_dashboard.json'
d=json.load(io.open(P,encoding='utf-8'))
V=d['visualizations']; DS=d['dataSources']

for k in [k for k in V if k.startswith('viz_node_') or k.startswith('viz_link_')]:
    del V[k]
d['layout']['structure']=[s for s in d['layout']['structure']
                          if not (s['item'].startswith('viz_node_') or s['item'].startswith('viz_link_'))]
struct=d['layout']['structure']
for k in [k for k in DS if k.startswith('ds_node_') or k.startswith('ds_link_')]:
    del DS[k]

N=168                 # node panel size
ICON_CY=0.318         # icon centre, fraction of node height (derived, see README)
ICON_R=50.5           # icon half-size in px (iconRoom/2 for a 168px panel)
COLW=216              # column pitch (N + 40 gutter)
BANDS={'colorBands':[{'from':None,'to':60,'value':'#3fb950'},
                     {'from':60,'to':85,'value':'#d29922'},
                     {'from':85,'to':None,'value':'#f85149'}]}

# columns x, rows y — every node snaps to this grid so corridors stay clean
CX=[36, 336, 636, 936, 1236, 1536, 1836]
ROW=[332, 508, 684, 860, 1036]           # not all used per column

NODES=[
 # key,     label,     icon,       cpu, col, y,    pulse
 ('inet',  'INTERNET','cloud',      12, 0,  508,'none'),
 ('fw',    'FW-01',   'firewall',   46, 1,  508,'none'),
 ('ids',   'IDS-01',  'eye',        58, 1,  880,'none'),
 ('siem',  'SIEM',    'shield',     44, 0,  880,'none'),
 ('lb1',   'LB-01',   'router',     34, 2,  392,'none'),
 ('lb2',   'LB-02',   'router',     29, 2,  628,'none'),
 ('web1',  'WEB-01',  'server',     48, 3,  272,'none'),
 ('web2',  'WEB-02',  'server',     71, 3,  508,'none'),
 ('web3',  'WEB-03',  'server',     55, 3,  744,'none'),
 ('app1',  'APP-01',  'server',     57, 4,  392,'none'),
 ('app2',  'APP-02',  'server',     91, 4,  628,'ring'),
 ('auth',  'AUTH-01', 'lock',       38, 4,  120,'none'),
 ('cache', 'CACHE',   'endpoint',   42, 5,  272,'none'),
 ('db',    'DB-PRI',  'database',   88, 5,  508,'ring'),
 ('dbrep', 'DB-REP',  'database',   61, 5,  790,'none'),
 ('bkup',  'BACKUP',  'database',   19, 5, 1036,'none'),
]
npos={}
for key,lbl,icon,cpu,col,y,pulse in NODES:
    x=CX[col]; y=y+214; npos[key]=(x,y)
    V['viz_node_'+key]={
      "type":"custom_viz_icon_status.custom_viz_icon_status",
      "dataSources":{"primary":"ds_node_"+key},
      "options":{
        "labelField":"> primary | seriesByName('label')",
        "valueField":"> primary | seriesByName('cpu')",
        "iconName":icon,"iconStyle":"solid","colorMode":"threshold", **BANDS,
        "labelText":lbl,"unitText":"%","aggregation":"last","valueDecimals":0,
        "showValue":True,"showLabel":True,"showGlow":True,"showShadow":True,
        "pulseMode":pulse,"showCard":False,"iconScale":1,
        "backgroundColor":"transparent"}}
    struct.append({"type":"block","item":"viz_node_"+key,
                   "position":{"x":x,"y":y,"w":N,"h":N}})
    DS['ds_node_'+key]={"type":"ds.chain","name":lbl+" CPU","options":{
      "extend":"ds_static",
      "query":'| where kind="node" AND c1="%s" | eval label=c1, cpu=tonumber(c2) | table label cpu'%lbl}}

def icon_c(k):
    x,y=npos[k]; return (x+N/2, y+N*ICON_CY)

# link: key, from, to, label, value, style, lw, mode, lane
#   lane = fractional offset (0..1) inside the corridor, for links sharing one gutter
LINKS=[
 ('inet_fw',   'inet','fw',   'WAN',        88,'pipe', 8,'range',0.5,None),
 ('fw_ids',    'fw','ids',    'ミラー',   'TAP','neon', 6,'match',0.5,None),
 ('ids_siem',  'ids','siem',  'アラート転送','OK','neon', 6,'match',0.5,None),
 ('fw_lb1',    'fw','lb1',    'HTTPS',      52,'pipe', 7,'range',0.4,'a'),
 ('fw_lb2',    'fw','lb2',    'HTTPS',      47,'pipe', 7,'range',0.6,'b'),
 ('lb1_web1',  'lb1','web1',  'HTTP',       38,'neon', 6,'range',0.4,'a'),
 ('lb1_web2',  'lb1','web2',  'HTTP',       64,'neon', 6,'range',0.6,'b'),
 ('lb2_web3',  'lb2','web3',  'HTTP',       41,'neon', 6,'range',0.45,None),
 ('web1_app1', 'web1','app1', '内部API',    45,'neon', 6,'range',0.42,'a'),
 ('web2_app2', 'web2','app2', '内部API',    83,'neon', 6,'range',0.58,'a'),
 ('web3_app2', 'web3','app2', '内部API',    58,'neon', 6,'range',0.42,'b'),
 ('app1_auth', 'app1','auth', 'OIDC',     'OK','neon', 6,'match',0.5,None),
 ('app1_cache','app1','cache','キャッシュ','HIT','neon',6,'match',0.4,'a'),
 ('app1_db',   'app1','db',   'SQL',        52,'pipe', 7,'range',0.62,'m'),
 ('app2_db',   'app2','db',   'SQL',        94,'pipe', 7,'range',0.42,'b'),
 ('db_dbrep',  'db','dbrep',  'レプリカ',   33,'pipe', 6,'range',0.5,None),
 ('dbrep_bkup','dbrep','bkup','バックアップ','DELAY','neon', 6,'match',0.5,None),
]

# Explicit label placement (link key -> [x, y] in 0..1 panel coords).
# The default is the line midpoint; these are the cases where that lands on a
# node's value text or on top of a sibling chip. Verified on the instance.
LABEL_POS={
    # Each value is [x, y] in 0..1 panel coords, chosen so the chip lands in the
    # free gap BETWEEN node columns/rows (the default midpoint put these on top
    # of a node's value text or on a sibling chip).
    'ids_siem':   [0.5, 0.5],     # gap between SIEM and IDS
    'lb2_web3':   [0.5, 0.25],    # upper leg, gap between LB-02 and WEB-03
    'web1_app1':  [0.5, 0.5],     # gap between WEB-01 and APP-01
    'app1_auth':  [0.5, 0.588],   # gap between AUTH-01 and APP-01
    'app1_cache': [0.46, 0.246],  # gap between APP-01 and CACHE (biased left,
                                  #   the chip is wide and CACHE has a glow)
    # SQL 52% rode the elbow right next to DB-PRI; pull it back onto the
    # horizontal upper leg, in the APP-01..DB gap
    'app1_db':    [0.44, 0.25],
}

RANGE_BANDS=[{'from':0,'to':40,'value':'#53a051'},{'from':40,'to':70,'value':'#f8be34'},
             {'from':70,'to':90,'value':'#f1813f'},{'from':90,'to':None,'value':'#dc4e41'}]
MATCH=['OK|#53a051','HIT|#53a051','TAP|#4a7fb5','DELAY|#f8be34','MISS|#f8be34','FAIL|#dc4e41','NG|#dc4e41']

GAP=8          # clearance from node panel edges
static_rows=[]
placed=[]      # link panels already positioned, for lane de-confliction

# Work out which links share a gutter (same column pair). When two do, the one
# whose span sits higher takes the upper half and the other the lower half.
_gut={}
for _k,_a,_b,*_ in LINKS:
    ax0,_=npos[_a]; bx0,_=npos[_b]
    ay0=npos[_a][1]; by0=npos[_b][1]
    if abs(ax0-bx0) >= abs(ay0-by0):
        _gut.setdefault((min(ax0,bx0),max(ax0,bx0)),[]).append(_k)
BAND={}
for _cols,_ks in _gut.items():
    if len(_ks) < 2: continue
    def _mid(k):
        for kk,_a,_b,*_ in LINKS:
            if kk==k:
                return (icon_c(_a)[1]+icon_c(_b)[1])/2
    for _i,_k in enumerate(sorted(_ks, key=_mid)):
        BAND[_k] = 'upper' if _i==0 else 'lower'

for key,a,b,label,val,style,lw,mode,lane,split in LINKS:
    band = BAND.get(key)
    ax0,ay0=npos[a]; bx0,by0=npos[b]
    acx,acy=icon_c(a); bcx,bcy=icon_c(b)
    horiz = abs(ax0-bx0) >= abs(ay0-by0)

    # Link panels are allowed to overlap the node panels, so each link simply
    # spans from its source icon centre to its destination icon centre with a
    # margin big enough for the end cap, the arrowhead and the label chip.
    if abs(bcx-acx) >= abs(bcy-acy):     # mostly horizontal
        MX, MY = 40, 58
    else:                                 # mostly vertical: label needs width
        MX, MY = 132, 40
    px = min(acx,bcx)-MX; pw = abs(bcx-acx)+MX*2
    py = min(acy,bcy)-MY; ph = abs(bcy-acy)+MY*2

    # Stop the line at the icon edge instead of the icon centre, so it never
    # runs across the artwork. The route is orthogonal, so each end leaves along
    # the axis that dominates the run — trim along that same axis.
    # The value/label text sits BELOW the icon, so a downward exit has to clear
    # that text too — the trim is asymmetric (measured from icon-status's layout:
    # icon centre 53.5, icon bottom 104, text ends 163 on a 168px panel).
    TRIM_SIDE = ICON_R + 6                 # left/right: icon half-size + air gap
    TRIM_UP   = ICON_R + 6                 # upward: clears the icon only
    TRIM_DOWN = 118                        # downward: clears icon + value + label
    if abs(bcx-acx) >= abs(bcy-acy):       # run is mostly horizontal
        _s = 1 if bcx >= acx else -1
        sax, say = acx + _s*TRIM_SIDE, acy
        ebx, eby = bcx - _s*TRIM_SIDE, bcy
    else:                                  # run is mostly vertical
        if bcy >= acy:                     # downward: leave under source's text
            sax, say = acx, acy + TRIM_DOWN
            ebx, eby = bcx, bcy - TRIM_UP
        else:                              # upward
            sax, say = acx, acy - TRIM_UP
            ebx, eby = bcx, bcy + TRIM_DOWN

    def norm(cx,cy): return ((cx-px)/pw, (cy-py)/ph)
    sx,sy=norm(sax,say); ex,ey=norm(ebx,eby)

    capR  = min(max(lw*0.8+3,6),24)
    ring  = capR*1.9 + 3
    arrow = max(11,lw*2.3) + 3
    isx,isy = ring/pw,  ring/ph
    iex,iey = arrow/pw, arrow/ph
    cl=lambda v,lo,hi: max(lo,min(hi,v))
    sx=cl(sx,isx,1-isx); sy=cl(sy,isy,1-isy)
    ex=cl(ex,iex,1-iex); ey=cl(ey,iey,1-iey)

    r=lambda v: round(v,3)
    horizrun = abs(bcx-acx) >= abs(bcy-acy)
    if horizrun:
        pts=[[r(sx),r(sy)]] + ([[r(lane),r(sy)],[r(lane),r(ey)]] if abs(sy-ey)>0.02 else []) + [[r(ex),r(ey)]]
    else:
        pts=[[r(sx),r(sy)]] + ([[r(sx),r(lane)],[r(ex),r(lane)]] if abs(sx-ex)>0.02 else []) + [[r(ex),r(ey)]]

    o={"valueField":"> primary | seriesByName('%s')"%('status' if mode=='match' else 'usage'),
       "linePoints":json.dumps(pts),"cornerRadius":12,
       "styleMode":style,"lineWidth":lw,"lineGradient":mode=='range',
       "flowSpeed":2.0,"flowDirection":"forward","showEndCaps":True,"arrowHead":True,
       "showValue":True,"linkLabel":label,"lineOpacity":100,
       "allowViewEdit":False,"backgroundColor":"transparent"}
    if mode=='range':
        o.update({"valueDecimals":0,"unitLabel":"%","colorMode":"range","colorBands":RANGE_BANDS})
        static_rows.append('link,%s,%s,,'%(key,val))
    else:
        o.update({"colorMode":"match","matchColors":MATCH,"dashLength":12})
        static_rows.append('stat,%s,,%s,'%(key,val))

    if key in LABEL_POS:
        o['labelPos']=json.dumps(LABEL_POS[key])

    V['viz_link_'+key]={"type":"custom_viz_link_line.custom_viz_link_line",
                        "dataSources":{"primary":"ds_link_"+key},"options":o}
    struct.append({"type":"block","item":"viz_link_'"[:-1]+key,
                   "position":{"x":int(round(px)),"y":int(round(py)),
                               "w":int(round(pw)),"h":int(round(ph))}})
    fld='status' if mode=='match' else 'usage'
    kind='stat' if mode=='match' else 'link'
    col='c3' if mode=='match' else 'tonumber(c2)'
    DS['ds_link_'+key]={"type":"ds.chain","name":key,"options":{
      "extend":"ds_static",
      "query":'| where kind="%s" AND c1="%s" | eval %s=%s | table %s'%(kind,key,fld,col,fld)}}

rows=['node,%s,%d,,'%(lbl,cpu) for _,lbl,_,cpu,_,_,_ in NODES]+static_rows
rows+=['res,CPU 平均使用率,64,80,58','res,メモリ使用率,77,85,71','res,ディスク I/O 使用率,52,75,60',
       'res,ネットワーク帯域,41,70,38','res,DB コネクション,88,90,74']
DS['ds_static']={"type":"ds.search","name":"静的な参照データ（共通）","options":{
  "query":'| makeresults format=csv data="kind,c1,c2,c3,c4\n%s"'%"\n".join(rows)}}
DS['ds_service_status']={"type":"ds.chain","name":"サービス総合ステータス","options":{
  "extend":"ds_static",
  "query":'| where kind="node" | eval cpu=tonumber(c2) | eval over=if(cpu>=85,1,0) '
          '| stats sum(over) as n count as t | eval scope="本番系 全".t."台 / しきい値超過 ".n."台", '
          'state=case(n=0,"ok",n<3,"warn",1=1,"crit") | table scope state'}}

json.dump(d,io.open(P,'w',encoding='utf-8'),ensure_ascii=False,indent=2)
print('nodes',len(NODES),'links',len(LINKS))
