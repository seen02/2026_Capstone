(()=>{
 let view=location.hash==='#operator'?'operator':'visitor';
 function render(keepPosition=false){const y=scrollY;document.querySelector('#app').innerHTML=view==='visitor'?MareaVisitor.render():MareaOperator.render();document.querySelectorAll('[data-view]').forEach(b=>{b.classList.toggle('active',b.dataset.view===view);b.setAttribute('aria-pressed',b.dataset.view===view)});document.title=`MAREA — ${view==='visitor'?'나의 속도로 만나는 바다':'운영자 대시보드'}`;if(keepPosition)window.scrollTo(0,y)}
 document.addEventListener('click',e=>{
 const b=e.target.closest('button,a,[data-zone]');if(!b)return;
 if(b.dataset.view){document.querySelector('#dialog').close();view=b.dataset.view;history.replaceState(null,'',`#${view}`);render();window.scrollTo(0,0);return}
 if(b.dataset.zone){if(view==='visitor')MareaVisitor.detail(b.dataset.zone);else{MareaOperator.selected=b.dataset.zone;render(true)}return}
 if(b.dataset.period){MareaOperator.period=b.dataset.period;render(true);return}
 const a=b.dataset.action;if(!a)return;
 if(a==='preferences')MareaVisitor.preferences();
 else if(a==='choose-route'){b.innerHTML=`${MareaUI.icon('check')} 이 관람길을 선택했어요`;MareaUI.toast('관람길 선택 화면 예시입니다. 실제 길 안내는 시작되지 않습니다.')}
 else if(a==='add-zone'){document.querySelector('#dialog').close();MareaUI.toast('관람길에 담았어요. 디자인 미리보기에서는 저장되지 않습니다.')}
 else if(a==='program'){const p=MareaDemo.programs.find(p=>p.name===b.dataset.name);MareaUI.modal(p.name,`<p class="dialog-description">${p.zone} · 오늘 ${p.time}<br>${p.sub}<br>바다와 더 가까워지는 이야기를 만나보세요.<br>시작 10분 전 대기 안내</p><div class="info-note">공연 시간과 내용은 디자인 검토용 예시입니다.</div><button class="button primary full" data-action="add-zone">관람길에 담기 ${MareaUI.icon('check')}</button>`)}
 else if(a==='signs')MareaOperator.signs();
 else if(a==='zones')document.querySelector('#operations-map').scrollIntoView({behavior:'smooth'});
 else if(a==='analytics')document.querySelector('#traffic-panel').scrollIntoView({behavior:'smooth'});
 else if(a==='overview')window.scrollTo({top:0,behavior:'smooth'});
 else if(a==='refresh')MareaUI.toast('샘플 데이터 화면입니다. 실제 데이터는 수신하지 않습니다.');
 else if(a==='notifications')MareaUI.modal('확인이 필요한 알림',`<div class="info-note"><strong>D 해파리 · 혼잡</strong><br>14:30 · 정원 대비 점유율 86%, 예상 대기 12분.<br>B 산호 구역으로 분산 안내를 검토하세요.</div><p class="dialog-description">알림 동작 확인을 위한 가상 이벤트입니다.</p>`);
 else if(a==='schedule')MareaUI.modal('오늘의 공연 일정',`<div class="device-list">${MareaDemo.programs.map(p=>`<div><strong>${p.time} · ${p.name}</strong><span class="tiny">${p.zone}</span></div>`).join('')}</div><div class="info-note">디자인 미리보기용 일정입니다.</div>`);
 else if(a==='settings')MareaUI.modal('운영 설정',`<p class="dialog-description">시설 정보와 혼잡 기준을 관리하는 화면 예시입니다.</p><div class="device-list"><div><strong>시설</strong><span>마레아 아쿠아리움 · 1F</span></div><div><strong>혼잡 기준 예시</strong><span>여유 60% 미만 / 혼잡 80% 이상</span></div></div><div class="info-note">설정 변경과 실제 운영 시스템 연결은 후속 구현 범위입니다.</div>`);
 else if(a==='help')MareaUI.modal('디자인 미리보기 안내',`<p class="dialog-description">관람객 웹과 운영자 대시보드의 디자인을 평가하는 프로토타입입니다. 구역 선택, 관람 설정, 경로 선택, 날짜 비교, 안내판 상세를 눌러보세요.</p><div class="info-note">인증, DB, 실시간 센서, 추천 알고리즘은 연결되어 있지 않습니다. 화면을 새로고침하면 선택 상태가 초기화됩니다.</div>`);
 });
 document.addEventListener('keydown',e=>{const zone=e.target.closest('.map-zone');if(zone&&['Enter',' '].includes(e.key)){e.preventDefault();zone.dispatchEvent(new MouseEvent('click',{bubbles:true}))}});
 document.querySelector('#dialog').addEventListener('click',e=>{if(e.target.id==='dialog'){const r=e.target.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)e.target.close()}});
 render();
})();
