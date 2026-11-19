"""직선 대기 자리의 정적 배치 검증. 회전·진입 구간에는 자리를 두지 않는다."""
import math


def queue_layout(bounds, entrance, rules, boarding_capacity, ride_bounds=None, queue_capacity=None):
    x,z,w,d=bounds
    side='left' if entrance[0]==x else 'right' if entrance[0]==x+w else 'top' if entrance[1]==z else 'bottom'
    horizontal=side in ('left','right')
    length,breadth=(w,d) if horizontal else (d,w)
    def base_transform(u,v):
        if side=='left': return [round(x+u,6),round(z+v,6)]
        if side=='right': return [round(x+w-u,6),round(z+v,6)]
        if side=='top': return [round(x+v,6),round(z+u,6)]
        return [round(x+v,6),round(z+d-u,6)]
    rows=[]
    v=1.2
    while v<=breadth-1.2+1e-8:
        rows.append(v);v+=2.4
    near,far=3.6,length-2.4
    slots=[]
    def distance(p):
        if not ride_bounds: return 0
        a,b,w,h=ride_bounds
        return math.hypot(max(a-p[0],0,p[0]-a-w),max(b-p[1],0,p[1]-b-h))
    end_u=far if len(rows)%2 else near
    reverse_rows=bool(ride_bounds and distance(base_transform(end_u,0))<distance(base_transform(end_u,breadth)))
    def transform(u,v): return base_transform(u,breadth-v if reverse_rows else v)
    raw_entry_v=entrance[1]-z if horizontal else entrance[0]-x
    entry_v=breadth-raw_entry_v if reverse_rows else raw_entry_v
    points=[]
    def add(point):
        if not points or math.dist(point,points[-1])>1e-8: points.append(point)
    add([0,entry_v]);add([.9,entry_v])
    if abs(entry_v-rows[0])>=1.2: add([.9,rows[0]])
    add([near-.65,rows[0]]);add([near,rows[0]])
    shoulder_start=len(points)-1
    clearance=rules['end_clearance_m'];spacing=rules['spacing_m']
    usable=abs(far-near)-2*clearance
    max_per_row=max(0,math.floor(usable/spacing+1e-8)+1)
    max_capacity=max_per_row*len(rows)
    if queue_capacity is not None and (type(queue_capacity) is not int or not 1<=queue_capacity<=max_capacity):
        raise ValueError(f'지정한 대기 정원은 실제 배치 가능한 {max_capacity}자리 이내의 양의 정수여야 합니다.')
    per_row,extra=divmod(max_capacity if queue_capacity is None else queue_capacity,len(rows))
    slot_indices=[]
    for i,v in enumerate(rows):
        start,end=(far,near) if i%2 else (near,far)
        count=per_row+(i<extra)
        direction=1 if end>start else -1
        for j in range(count):
            u=start+direction*(clearance+j*spacing)
            slots.append(transform(u,v))
            add([u,v]);slot_indices.append(len(points)-1)
        if ride_bounds and i==len(rows)-1:
            bevel=min(.45,clearance*.8,(breadth-v)*.5)
            add([end-direction*bevel,v]);add([end,v+bevel])
        else:
            add([end,v])
        if i<len(rows)-1:
            for k in range(1,13):
                theta=-math.pi/2+k*math.pi/12
                add([end+(-1 if i%2 else 1)*1.2*math.cos(theta),v+1.2+1.2*math.sin(theta)])
    if ride_bounds: add([end_u,breadth])
    boarding_exit=transform(*points[-1]) if ride_bounds else None
    boarding_target=[max(ride_bounds[0],min(boarding_exit[0],ride_bounds[0]+ride_bounds[2])),max(ride_bounds[1],min(boarding_exit[1],ride_bounds[1]+ride_bounds[3]))] if ride_bounds else None
    normals=[]
    for a,b in zip(points,points[1:]):
        dx,dz=b[0]-a[0],b[1]-a[1];length=math.hypot(dx,dz)
        normals.append([-dz/length,dx/length])
    def offset(i, width):
        u,v=points[i]
        a,b=normals[max(0,i-1)],normals[min(i,len(normals)-1)]
        nx,nz=a[0]+b[0],a[1]+b[1];den=nx*b[0]+nz*b[1]
        return transform(0 if i==0 else u+width*nx/den,v+width*nz/den)
    # 출입 흐름을 분리한다. 첫 줄 바깥 벨트의 개구부는 역방향 보행 전용이다.
    shoulder_width=1.18
    rail_paths=[
        [offset(i,.6) for i in range(len(points))],
        [offset(i,-.6) for i in range(shoulder_start)],
        [transform(near+.65,rows[0]-shoulder_width),
         *(offset(i,-shoulder_width) for i in range(shoulder_start+1,len(points))
           if points[i][1]!=rows[0] or points[i][0]>near+.65)],
    ]
    if ride_bounds and len(rows)%2==0:
        # 마지막 굽이 안쪽의 넓은 벨트는 한 번만 꺾어 말단 이탈 자리를 확보한다.
        rail_paths[2][-3:-1]=[transform(end_u+shoulder_width,rows[-1]+shoulder_width)]
    withdrawal_end=slot_indices[-1]+1 if slot_indices else len(points)
    withdrawal=[transform(near,0),*(offset(i,-.64) for i in range(shoulder_start,withdrawal_end))]
    rails=[[a,b] for path in rail_paths for a,b in zip(path,path[1:])]
    minimum=math.ceil(boarding_capacity*rules['minimum_boarding_multiple'])
    return dict(capacity=len(slots),boarding_capacity=boarding_capacity,minimum_capacity=minimum,
                meets_minimum=len(slots)>=minimum,slots=slots,rails=rails,railPaths=rail_paths,boarding_exit=boarding_exit,boarding_target=boarding_target,reverse_rows=reverse_rows,person_radius_m=rules['person_radius_m'],spacing_m=spacing,
                points=[transform(*p) for p in points],slot_indices=slot_indices,withdrawal=withdrawal,
                withdrawal_slot_indices=[i-shoulder_start+1 for i in slot_indices])


def queue_report(map_data):
    points={n['id']:n['point'] for n in map_data['geometry']['nodes']}
    return {f['id']:queue_layout(f['queue'],points[f['entrance']],map_data['geometry']['queue_rules'],
                                 f['boarding_capacity'],f['bounds'],f.get('queue_capacity'))
            for f in map_data['facilities']}


def validate_queue_capacity(map_data, require, number):
    from .map_geometry import distance_to_segment, segment_rect_distance
    rules=map_data['geometry']['queue_rules']
    require(number(rules['person_radius_m'],.23,.5),'대기 자리 반경이 올바르지 않습니다.')
    require(number(rules['spacing_m'],rules['person_radius_m']*2,2),'대기 자리 간격이 몸체 지름보다 작습니다.')
    require(number(rules['end_clearance_m'],rules['person_radius_m'],2),'대기줄 회전 여백이 부족합니다.')
    require(number(rules['minimum_boarding_multiple'],2.5,10),'대기 수용 기준은 1회 탑승 정원의 2.5배 이상이어야 합니다.')
    for facility in map_data['facilities']:
        require(type(facility['boarding_capacity']) is int and facility['boarding_capacity']>0,'1회 탑승 정원은 양의 정수여야 합니다.')
        if 'queue_capacity' in facility:
            require(type(facility['queue_capacity']) is int and facility['queue_capacity']>0,
                    '대기 정원은 양의 정수여야 합니다.')
    reports=queue_report(map_data)
    for facility in map_data['facilities']:
        report=reports[facility['id']];x,z,w,d=facility['queue'];radius=rules['person_radius_m']
        require(all(x<=px<=x+w and z<=pz<=z+d for px,pz in [*report['points'], *report['withdrawal'],
                                                             *(p for path in report['railPaths'] for p in path)]),
                '대기 보행이나 벨트가 대기 구획 밖으로 나갑니다.')
        entry=next(n['point'] for n in map_data['geometry']['nodes'] if n['id']==facility['entrance'])
        boarding=report['boarding_exit'];target=report['boarding_target']
        require(math.dist(boarding,target)<math.hypot(max(facility['bounds'][0]-entry[0],0,entry[0]-facility['bounds'][0]-facility['bounds'][2]),max(facility['bounds'][1]-entry[1],0,entry[1]-facility['bounds'][1]-facility['bounds'][3])),'대기줄 입구보다 탑승 진입점이 놀이기구에 가까워야 합니다.')
        obstacles=[map_data['geometry']['castle'],*map_data['geometry']['scenery_buildings'],*map_data['geometry']['landscape_beds']]
        obstacles += [f[k] for f in map_data['facilities'] for k in ('bounds','queue','exit_area') if f['id']!=facility['id'] or k=='exit_area']
        require(all(segment_rect_distance(boarding,target,r)>=.3 for r in obstacles),'탑승 진입 연결이 다른 구획을 침범합니다.')
        require(report['meets_minimum'],f"{facility['name']} 대기 자리가 1회 탑승 정원의 2.5배보다 적습니다.")
        for i,point in enumerate(report['slots']):
            require(x+radius<=point[0]<=x+w-radius and z+radius<=point[1]<=z+d-radius,'대기 자리 몸체가 구획 밖으로 나갑니다.')
            require(all(math.dist(point,other)>=rules['spacing_m']-1e-6 for other in report['slots'][i+1:]),'대기 자리 간격이 겹칩니다.')
            require(all(distance_to_segment(point,*rail)>=radius+.22 for rail in report['rails']),'대기 자리 몸체가 기둥·벨트를 침범합니다.')
