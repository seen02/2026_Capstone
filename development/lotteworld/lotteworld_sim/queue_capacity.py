"""직선 대기 자리의 정적 배치 검증. 회전·진입 구간에는 자리를 두지 않는다."""
import math


def queue_layout(bounds, entrance, rules, boarding_capacity, ride_bounds=None):
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
    for p in ([0,entry_v],[.9,entry_v],[.9,rows[0]],[near,rows[0]]): add(p)
    clearance=rules['end_clearance_m'];spacing=rules['spacing_m']
    for i,v in enumerate(rows):
        start,end=(far,near) if i%2 else (near,far)
        usable=abs(end-start)-2*clearance
        count=max(0,math.floor(usable/spacing+1e-8)+1)
        direction=1 if end>start else -1
        slots.extend(transform(start+direction*(clearance+j*spacing),v) for j in range(count))
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
    rail_paths=[]
    for offset_side in (-1,1):
        path=[]
        for i,p in enumerate(points):
            a,b=normals[max(0,i-1)],normals[min(i,len(normals)-1)]
            nx,nz=a[0]+b[0],a[1]+b[1];den=nx*b[0]+nz*b[1]
            path.append(transform(p[0]+offset_side*.6*nx/den,p[1]+offset_side*.6*nz/den))
        rail_paths.append(path)
    rails=[[a,b] for path in rail_paths for a,b in zip(path,path[1:])]
    minimum=math.ceil(boarding_capacity*rules['minimum_boarding_multiple'])
    return dict(capacity=len(slots),boarding_capacity=boarding_capacity,minimum_capacity=minimum,
                meets_minimum=len(slots)>=minimum,slots=slots,rails=rails,railPaths=rail_paths,boarding_exit=boarding_exit,boarding_target=boarding_target,reverse_rows=reverse_rows,person_radius_m=rules['person_radius_m'],spacing_m=spacing)


def queue_report(map_data):
    points={n['id']:n['point'] for n in map_data['geometry']['nodes']}
    return {f['id']:queue_layout(f['queue'],points[f['entrance']],map_data['geometry']['queue_rules'],f['boarding_capacity'],f['bounds']) for f in map_data['facilities']}


def validate_queue_capacity(map_data, require, number):
    from .map_geometry import distance_to_segment, segment_rect_distance
    rules=map_data['geometry']['queue_rules']
    require(number(rules['person_radius_m'],.23,.5),'대기 자리 반경이 올바르지 않습니다.')
    require(number(rules['spacing_m'],rules['person_radius_m']*2,2),'대기 자리 간격이 몸체 지름보다 작습니다.')
    require(number(rules['end_clearance_m'],rules['person_radius_m'],2),'대기줄 회전 여백이 부족합니다.')
    require(number(rules['minimum_boarding_multiple'],2.5,10),'대기 수용 기준은 1회 탑승 정원의 2.5배 이상이어야 합니다.')
    for facility in map_data['facilities']:
        require(type(facility['boarding_capacity']) is int and facility['boarding_capacity']>0,'1회 탑승 정원은 양의 정수여야 합니다.')
    reports=queue_report(map_data)
    for facility in map_data['facilities']:
        report=reports[facility['id']];x,z,w,d=facility['queue'];radius=rules['person_radius_m']
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
