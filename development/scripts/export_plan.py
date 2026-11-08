"""지도 JSON에서 공유용 평면 SVG를 생성한다. 모든 좌표와 장애물은 지도와 동일하다."""
import html
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def export_plan(map_data):
    g = map_data['geometry']
    nodes = {n['id']: n for n in map_data['nodes']}
    scale, ox, oy = 12, 118, 118
    out = ['<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="950" viewBox="0 0 1100 950" role="img" aria-labelledby="title desc">',
           '<title id="title">가상 아쿠아리움 연속 갤러리 평면도</title>',
           '<desc id="desc">6개 전시, 벽면 수조, 연결 관람길, 두 지름길과 공연장 입퇴장 동선을 표시한 가상 설계도</desc>',
           '<defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M1,1 L9,5 L1,9" fill="none" stroke="context-stroke" stroke-width="1.7"/></marker></defs>',
           '<rect width="1100" height="950" fill="#10232e"/>',
           '<g font-family="Malgun Gothic, Noto Sans KR, sans-serif">']
    def text(value, x, y, size=16, fill='#d9e7eb', weight=400, anchor='middle'):
        out.append(f'<text x="{x:g}" y="{y:g}" fill="{fill}" font-size="{size}" font-weight="{weight}" text-anchor="{anchor}">{html.escape(value)}</text>')
    def point(x, z):
        return ox+x*scale, oy+z*scale
    def rect(bounds, fill, stroke='none', width=1, radius=0):
        x,z,w,d=bounds;px,py=point(x,z)
        out.append(f'<rect x="{px:g}" y="{py:g}" width="{w*scale:g}" height="{d*scale:g}" rx="{radius}" fill="{fill}" stroke="{stroke}" stroke-width="{width}"/>')
    def line(a,b,color,width=2,dash='',arrow=False):
        x1,y1=point(*a);x2,y2=point(*b)
        extra=(f' stroke-dasharray="{dash}"' if dash else '')+(' marker-end="url(#arrow)"' if arrow else '')
        out.append(f'<line x1="{x1:g}" y1="{y1:g}" x2="{x2:g}" y2="{y2:g}" stroke="{color}" stroke-width="{width:g}" stroke-linecap="round"{extra}/>')
    def pill(value,x,z,fill='#f4f7f1',ink='#1e3b49',size=16):
        px,py=point(x,z);w=max(64,len(value)*size*.83+16)
        out.append(f'<rect x="{px-w/2:g}" y="{py-14:g}" width="{w:g}" height="26" rx="5" fill="{fill}"/>')
        text(value,px,py+5,size,ink,600)
    text('가상 아쿠아리움 · 연속 갤러리',55,49,28,'#eef6f8',700,'start')
    text('6개 전시 / 단층 72 × 60m / 모든 치수는 가상 설계값',55,80,15,'#a9bec9',400,'start')
    rect(g['bounds'],'#243b46','#48616d',1.2)
    for area in g.get('building_floor_areas',g['walkable_areas']):
        rect(area['bounds'],'#9cacae' if area['kind']=='tank_floor' else '#e0dfd5' if area['kind']=='show' else '#dbe4df')
    for r in g['rooms']:
        for f in r.get('features',[r['feature']]):
            x,z,w,d=f['bounds']
            if f['kind']=='stage':
                rect(f['bounds'],'#c7a370','#e7c798',1.5)
                px,py=point(x+w/2,z+d/2);text('해양 공연 공간',px,py+5,16,'#342e26',600)
            elif f.get('style')=='jelly':
                rect(f['bounds'],'#59446f','#a28cb8',1.2)
                count=max(1,int(max(w,d)/3.2))
                for i in range(count):
                    cx=x+w*(i+.5)/count if w>d else x+w/2
                    cz=z+d/2 if w>d else z+d*(i+.5)/count
                    px,py=point(cx,cz)
                    out.append(f'<circle cx="{px:g}" cy="{py:g}" r="{min(1.2,min(w,d)*.42)*scale:g}" fill="#b49bd0" stroke="#ddc9ed" stroke-width="1"/>')
            else:
                points=' '.join(f'{px:g},{py:g}' for px,py in (point(*p) for p in f['polygon']))
                color='#3c969f' if f.get('style')=='coast' else '#2e829a'
                out.append(f'<polygon points="{points}" fill="{color}" stroke="#7ec7cf" stroke-width="1.5"/>')
                if f.get('style')=='reef':
                    px,py=point(x+w/2,z+d/2)
                    text('메인 산호 수조',px,py-6,21,'#e5f8f5',700)
                    text('다이버 먹이주기',px,py+20,14,'#cbe9ed')
                elif f.get('style')=='coast':
                    px,py=point(x+w/2,z+d/2)
                    text('연안 수조',px,py-4,19,'#eff9f1',600)
                    text('물범 생태설명',px,py+20,14,'#d5efec')
    for wall in g['walls']:
        line(wall['a'],wall['b'],'#967f52' if wall['kind']=='queue_rail' else '#526a75',max(2,wall['thickness']*scale))
        if wall['kind']=='queue_rail':
            count=max(1,math.ceil(math.dist(wall['a'],wall['b'])/2.5))
            for i in range(count+1):
                px,py=point(*(a+(b-a)*i/count for a,b in zip(wall['a'],wall['b'])))
                out.append(f'<circle cx="{px:g}" cy="{py:g}" r="3" fill="#334b5e"/>')
    # 대표 관람 방향만 표시한다. 일반 관람 경로는 양방향이다.
    route_index=0
    for edge in map_data['edges']:
        a,b=nodes[edge['a']],nodes[edge['b']]
        p1,p2=(a['x'],a['z']),(b['x'],b['z'])
        if edge['kind']=='promenade':
            route_index+=1
            if route_index%2:
                t1,t2=.25,.65
                line((p1[0]+(p2[0]-p1[0])*t1,p1[1]+(p2[1]-p1[1])*t1),(p1[0]+(p2[0]-p1[0])*t2,p1[1]+(p2[1]-p1[1])*t2),'#849a9e',1.8,arrow=True)
        elif edge['kind']=='shortcut':line(p1,p2,'#328c76',2.4,'5 4',True)
        elif edge['kind'] in ('admission','exit_path'):
            line(p1,p2,'#ab753e' if edge['kind']=='exit_path' else '#338d77',2,arrow=True)
    for door in g['doors']:
        delta=door['width']/2
        a=(door['x']-delta,door['z']) if door['axis']=='x' else (door['x'],door['z']-delta)
        b=(door['x']+delta,door['z']) if door['axis']=='x' else (door['x'],door['z']+delta)
        line(a,b,'#b37b44' if door['role']=='exit' else '#49a68e',4)
    for r in g['rooms']:
        pill(r['name'],*r['label_position'])
    show=next(r for r in g['rooms'] if r['id']=='F');q=show['queue_area']
    for a,b in zip(show['queue_path'],show['queue_path'][1:]):line(a,b,'#338d77',1.3,arrow=True)
    pill('공연 대기',q[0]+q[2]/2,q[1]+q[3]/2,'#f0dfbb','#5a4829',12)
    for door in g['doors']:
        pill('출구' if door['role']=='exit' else '입구',door['x'],door['z']+2,'#f2dfc8' if door['role']=='exit' else '#daeee5','#935e2c' if door['role']=='exit' else '#27715d',11)
    pill('공용 로비',17,51,'#eef3ee','#435c69',14)
    for s in map_data['signs']:
        n=nodes[s['node']];px,py=point(n['x'],n['z'])
        out.append(f'<circle cx="{px:g}" cy="{py:g}" r="11" fill="#235b66" stroke="#b7e5d7" stroke-width="1.2"/>')
        text(s['id'][-1],px,py+4,12,'#e5fff2',700)
    for nid,label in [('entry','입구'),('exit','출구')]:
        n=nodes[nid];pill(label,n['x'],n['z'], '#d8f1e4' if nid=='entry' else '#f3dfc4', '#245b47' if nid=='entry' else '#8b582b',14)
    # 도면 밖의 범례는 실제 보행 공간의 일부가 아니다.
    legend=[('관람 바닥','#dbe4df'),('수조','#2e829a'),('비관람 영역','#243b46'),('공연 대기','#ddc696')]
    for i,(name,color) in enumerate(legend):
        x=120+i*175
        out.append(f'<rect x="{x}" y="872" width="17" height="17" rx="2" fill="{color}" stroke="#78919e" stroke-width=".7"/>')
        text(name,x+27,886,14,'#c7d8de',400,'start')
    text('1 · 2 · 3 안내판  |  민트 화살표: 연결 통로 / 공연 입장  |  황갈색 화살표: 공연 퇴장',120,916,13,'#a9c2cd',400,'start')
    text('일반 관람길은 양방향 · 화살표는 대표 흐름 · 실제 시설의 실측 도면이 아닙니다',120,938,12,'#8da9b7',400,'start')
    line((59,60.5),(69,60.5),'#b6d0d9',1.5)
    px,py=point(64,60.5);text('10m',px,py+16,11,'#b6d0d9')
    out.append('</g></svg>')
    return '\n'.join(out)+'\n'


if __name__=='__main__':
    data=json.loads((ROOT/'configs/aquarium_map.json').read_text(encoding='utf-8'))
    target=ROOT/'web/floorplan.svg'
    target.write_text(export_plan(data),encoding='utf-8')
    print('평면도 생성: web/floorplan.svg')
