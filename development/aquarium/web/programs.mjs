export function activePrograms(programs,time){
  return programs.filter(p=>{
    const [h,m]=p.start.split(':').map(Number),start=h*3600+m*60;
    return start<=time&&time<start+p.duration_minutes*60;
  });
}
