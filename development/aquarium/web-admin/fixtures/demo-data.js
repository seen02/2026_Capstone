/* 디자인 검토 전용 데이터. API 응답 및 실제 관측값이 아닙니다. */
window.MareaDemo = {
  updatedAt: '14:32',
  zones: [
    {id:'A',name:'연안',tag:'햇빛이 머무는 바다',count:42,capacity:90,wait:2,status:'여유',tone:'calm',time:12},
    {id:'B',name:'산호',tag:'색으로 가득한 작은 우주',count:38,capacity:80,wait:0,status:'여유',tone:'calm',time:15},
    {id:'C',name:'심해',tag:'아직 만나지 못한 세계',count:64,capacity:90,wait:4,status:'보통',tone:'moderate',time:18},
    {id:'D',name:'해파리',tag:'느리게 흐르는 빛',count:86,capacity:100,wait:12,status:'혼잡',tone:'busy',time:10},
    {id:'E',name:'민물',tag:'강에서 시작되는 이야기',count:31,capacity:70,wait:0,status:'여유',tone:'calm',time:12},
    {id:'F',name:'공연',tag:'바다와 마주하는 순간',count:51,capacity:100,wait:6,status:'보통',tone:'moderate',time:25}
  ],
  summary:{inside:312,entered:746,exited:434},
  programs:[{time:'14:50',zone:'B 산호',name:'다이버와 산호의 오후',sub:'먹이주기 이야기 · 15분',state:'곧 시작'}, {time:'15:30',zone:'F 공연',name:'바다가 들려주는 이야기',sub:'해양 생태 공연 · 25분',state:'예정'}]
};
