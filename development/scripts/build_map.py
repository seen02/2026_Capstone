"""수조와 전시벽 사이를 잇는 가상 단층 갤러리. 모든 치수는 설계 가정(m)."""
import json
import math
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]


def rectangle(b):
    x,z,w,d=b
    return [[x,z],[x+w,z],[x+w,z+d],[x,z+d]]


def build_map():
    nodes=[];edges=[];rooms=[];walls=[];doors=[]
    def node(id,name,p,kind='junction',**extra):
        nodes.append(dict(id=id,name=name,floor='1F',x=p[0],z=p[1],kind=kind,**extra));return id
    def edge(a,b,kind='promenade',width=4,directed=False):
        na=next(n for n in nodes if n['id']==a);nb=next(n for n in nodes if n['id']==b)
        length=math.hypot(na['x']-nb['x'],na['z']-nb['z'])
        edges.append(dict(id=a+'--'+b,a=a,b=b,kind=kind,directed=directed,length_m=length,
                          seconds=length/1.2,width_assumption=width,evidence='가상 설계 길이 / 가정 보행속도 1.2m/s'))
    def wall(a,b,kind='partition',height=2.8,thickness=.3):
        walls.append(dict(a=list(a),b=list(b),thickness=thickness,height=height,kind=kind))
    points={'lobby':(12,53),'fresh_s':(12,46),'fresh_n':(12,33),'coast_s':(12,27),
            'coast_e':(23,26),'west':(27,28),'reef_w':(32,28),'reef_front':(42,28),
            'reef_e':(52,28),'deep_s':(58,26),'deep_n':(58,17),'deep_e':(62,17),
            'jelly_n':(62,30),'jelly_m':(62,34),'east':(58,38),'show_front':(43,34),
            'south':(27,34),'return':(25,53),'show_out_1':(62,41),'show_out_2':(62,39)}
    for id,p in points.items():node(id,'연결 관람길',p)
    loop=['lobby','fresh_s','fresh_n','coast_s','coast_e','west','reef_w','reef_front','reef_e',
          'deep_s','deep_n','deep_e','jelly_n','jelly_m','east','show_front','south','return','lobby']
    for a,b in zip(loop,loop[1:]):edge(a,b)
    edge('west','south','shortcut');edge('reef_front','show_front','shortcut')
    node('entry','입구',(10,57),'entry');node('exit','출구',(25,57),'exit')
    edge('entry','lobby','lobby',3,True);edge('return','exit','lobby',3,True)
    specs=[
      dict(id='A',name='연안',tag='coast',color='#218e99',cap=50,program='물범 생태설명',
           bounds=[6,18,18,13],view=[9,19,12,5],queue=[8,25,4,3],approach='coast_s',other='coast_e',label=[14,29],
           features=[('coast',[6,7,18,11],2.2)]),
      dict(id='B',name='산호',tag='coral',color='#c47f42',cap=60,program='다이버 먹이주기',
           bounds=[24,23,30,10],view=[33,24,17,6],queue=[27,25,3,4],approach='west',other='reef_e',label=[41,31],
           features=[('reef',[30,7,22,16],4.2)]),
      dict(id='C',name='심해',tag='deep',color='#526ab6',cap=35,program=None,
           bounds=[54,12,10,17],view=[55,14,5,8],queue=[54,24,4,4],approach='deep_s',other='deep_e',label=[59,23],
           features=[('wall',[54,6,15,21],3)]),
      dict(id='D',name='해파리',tag='jellyfish',color='#9565be',cap=20,program=None,
           bounds=[56,29,10,13],view=[61,32,4,7],queue=[56,35,4,4],approach='east',other='jelly_n',label=[60,30],
           features=[('jelly',[66,30,4,11],2.7)]),
      dict(id='E',name='민물',tag='freshwater',color='#43866a',cap=40,program=None,
           bounds=[6,31,14,18],view=[7,35,4,8],queue=[14,42,4,4],approach='fresh_s',other='fresh_n',label=[14,39],
           features=[('fresh',[2,33,4,11],2.3),('fresh',[20,35,4,9],2.3)]),
      dict(id='F',name='공연',tag='interactive',color='#b38b32',cap=80,program='해양 공연 프로그램',
           bounds=[32,41,34,17],view=[41,43,17,7],queue=[26.6,38.35,32,2.3],approach='east',other='show_out_1',label=[49,50.5],
           features=[('stage',[40,52,20,5],.65)])]
    for s in specs:
        id=s['id'];q=s['queue'];v=s['view'];controlled=id=='F'
        queue_id=node('queue_'+id,id+(' 공연 대기' if controlled else ' 관람 접근'),(q[0]+q[2]/2,q[1]+q[3]/2),'queue',zone=id)
        node(id,id+' '+s['name'],(v[0]+v[2]/2,v[1]+v[3]/2),'exhibit',zone=id,tag=s['tag'],capacity=s['cap'],
             dwell_minutes=[8,16] if s['program'] else [6,12],size=s['bounds'][2:],area_m2=s['bounds'][2]*s['bounds'][3],
             queue_node=queue_id,access_mode='controlled_show' if controlled else 'open_gallery',program=s['program'],
             capacity_evidence='가상 관람 상한. 법정 수용인원이나 실측치 아님')
        if controlled:
            for nid,p in [('show_lobby',(56,39.7)),('show_before',(36,39.7)),('show_gate',(36,41)),
                          ('show_after',(36,43)),('show_leave',(62,46))]:node(nid,'공연장 입퇴장',p,'door' if nid=='show_gate' else 'room_path',zone=id)
            for a,b in [(s['approach'],'show_lobby'),('show_lobby',queue_id)]:edge(a,b,'show_approach',3)
            for a,b in [(queue_id,'show_before'),('show_before','show_gate'),('show_gate','show_after'),('show_after',id)]:edge(a,b,'admission',3,True)
            for a,b in [(id,'show_leave'),('show_leave','show_out_1'),('show_out_1','show_out_2'),('show_out_2','east')]:edge(a,b,'exit_path',3,True)
            doors=[dict(id='show_gate',room=id,x=36,z=41,width=4,axis='x',role='admission'),
                   dict(id='show_out_1',room=id,x=62,z=41,width=4,axis='x',role='exit')]
        else:
            edge(s['approach'],queue_id,'gallery_access',3);edge(queue_id,id,'gallery_access',3);edge(id,s['other'],'gallery_access',3)
        features=[dict(kind='stage' if style=='stage' else 'tank',style=style,bounds=b,polygon=rectangle(b),height=h) for style,b,h in s['features']]
        if id=='C':
            features[0].update(polygon=[[54,6],[69,6],[69,27],[64,27],[64,12],[54,12]],
                               collision_bounds=[[54,6,15,6],[64,12,5,15]])
        rooms.append(dict(id=id,name=id+' '+s['name'],bounds=s['bounds'],polygon=rectangle(s['bounds']),color=s['color'],program=s['program'],
                          access_mode='controlled_show' if controlled else 'open_gallery',view_area=v,queue_area=q,label_position=s['label'],
                          feature=features[0],features=features,queue_node=queue_id,
                          entry_door='show_gate' if controlled else None,exit_door='show_out_1' if controlled else None))
        if controlled:
            slots=[[round(27+i*.8,2),z] for z in [40.0,38.8] for i in range(40)]
            # 공연 구역까지의 거리, 입구까지의 거리 순으로 빈자리를 배정한다.
            def priority(p):
                x,z=p;bx,bz,bw,bd=s['bounds']
                distance=max(bx-x,0,x-bx-bw)**2+max(bz-z,0,z-bz-bd)**2
                return (round(distance,6),(x-36)**2+(z-41)**2,x)
            rooms[-1]['queue_slots']=sorted(slots,key=priority)
            rooms[-1]['queue_rows']=[[[27,z],[58.2,z]] for z in [40.0,38.8]]
            rooms[-1]['queue_spacing_m']=.8
    # 건물 전체를 관람 바닥으로 칠하지 않는다. 실제 연결된 갤러리/통로의 합집합이다.
    areas=[('gallery',[6,18,18,13]),('gallery',[24,23,30,10]),('gallery',[54,12,10,17]),
           ('gallery',[56,29,10,13]),('gallery',[6,31,14,18]),('show',[32,41,34,17]),
           ('corridor',[24,29,6,24]),('corridor',[24,33,34,8]),('corridor',[20,27,4,8]),
           ('corridor',[50,24,8,5]),('lobby',[4,49,26,9]),('corridor',[20,45,6,6])]
    walkable=[dict(kind=k,bounds=b) for k,b in areas]
    cells=set()
    for _,(x,z,w,d) in areas:
        cells.update((i,j) for i in range(x,x+w) for j in range(z,z+d))
    feature_cells=set()
    support=[]
    for r in rooms:
        for f in r['features']:
            for x,z,w,d in f.get('collision_bounds',[f['bounds']]):
                feature_cells.update((i,j) for i in range(x,x+w) for j in range(z,z+d))
                if f['kind']=='tank':support.append(dict(kind='tank_floor',bounds=[x-1,z-1,w+2,d+2]))
    cells-=feature_cells
    # 수조와 그 둘레의 바닥까지 건물에 포함한다. 보행 가능 영역은 별도로 유지한다.
    building_cells=cells|feature_cells
    for area in support:
        x,z,w,d=area['bounds'];building_cells.update((i,j) for i in range(x,x+w) for j in range(z,z+d))
    segments={}
    for x,z in sorted(building_cells):
        for other,axis,fixed,start in [((x,z-1),'h',z,x),((x,z+1),'h',z+1,x),((x-1,z),'v',x,z),((x+1,z),'v',x+1,z)]:
            if other in building_cells:continue
            if axis=='h' and fixed==58 and (7<=start<16 or 23<=start<28):continue
            segments.setdefault((axis,fixed),[]).append(start)
    for (axis,fixed),values in sorted(segments.items()):
        values=sorted(set(values));start=last=values[0]
        for value in values[1:]+[None]:
            if value is not None and value==last+1:last=value;continue
            a,b=([start,fixed],[last+1,fixed]) if axis=='h' else ([fixed,start],[fixed,last+1])
            wall(a,b)
            if value is not None:start=last=value
    # 전시실 경계의 넓은 개구부, 차광 입구, 공연실 입퇴장 문.
    for a,b in [((6,31),(9,31)),((15,31),(20,31)),((54,29),(59,29)),((65,29),(66,29)),
                ((30,33),(39,33)),((46,33),(54,33))]:wall(a,b)
    for a,b in [((32,41),(34,41)),((38,41),(60,41)),((64,41),(66,41))]:wall(a,b,'show_wall')
    wall((27,38.35),(54.8,38.35),'queue_rail',.95,.1)
    programs=[]
    for nid,name,offset,duration in [('A','물범 생태설명',0,15),('B','다이버 먹이주기',10,15),('F','해양 공연 프로그램',20,20)]:
        for hour in [10,12,14,16]:programs.append(dict(node=nid,name=name,start=f'{hour:02}:{offset:02}',duration_minutes=duration))
    return dict(schema_version=8,name='가상 아쿠아리움 · 연속 갤러리',coordinate_system='1 모델 단위 = 1m',
        geometry_status=dict(status='synthetic_design',render_3d=True,verified_scale=False,length_unit='m',reason='공식 안내도의 연속 관람 유형을 참고한 가상 설계. 실제 치수 아님.'),
        floors=[dict(id='1F',name='1층 전체',elevation=0)],nodes=nodes,edges=edges,
        geometry=dict(bounds=[0,0,72,60],footprint=[[0,0],[72,0],[72,60],[0,60]],walkable_areas=walkable,
                      building_floor_areas=support+walkable,
                      wall_height_m=2.8,rooms=rooms,walls=walls,doors=doors,service_areas=[],human_height_m=1.7,human_radius_m=.23,
                      labels=[dict(text='공용 로비',x=17,z=51)]),
        signs=[dict(id='S01',node='west',name='메인수조 / 공연장 분기'),dict(id='S02',node='reef_front',name='심해 / 공연장 분기'),dict(id='S03',node='east',name='해파리 / 공연장 분기')],
        reference_programs=sorted(programs,key=lambda p:(p['start'],p['node'])),sources=[],
        program_status='A·B·F 회차별 모집·선착순 정원 확보·순차 입장·동시 공연 종료 적용. A·B는 일반 관람과 정원을 공유하며 F는 공연 회차로만 입장.',
        assumptions=['단층 가상 설계: 6개 테마의 연속 갤러리. 보행 바닥과 수조 뒤 비관람 영역을 구분한다.',
                     '일반 전시는 넓은 개구부로 연결하며, F 공연장만 별도 입장 대기와 측면 퇴장을 둔다.',
                     '민물→연안→산호→심해→해파리→공연장 앞→로비의 주동선과 두 개의 연결 통로. 이동은 양방향이다.',
                     '벽·수조·무대는 장애물이다. 지도에 칠해진 보행면 밖으로 이동할 수 없다.',
                     '정원은 가상 관람 상한이다. 공용 관람길의 통행객은 선택 관람 인원에 포함하지 않는다.',
                     '모든 치수·정원·시간표·입장률은 가상 실험 설정이며 실제 통계가 아니다.',
                     '사람 키 1.7m·폭 0.46m. 사람 간 충돌·실제 면적 밀도·문별 통과량은 미구현.'])

if __name__=='__main__':
    (ROOT/'configs/aquarium_map.json').write_text(json.dumps(build_map(),ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print('연속 갤러리 지도 생성: 벽면 수조 · 실제 보행 바닥 · 공연실 · 연결 통로')
