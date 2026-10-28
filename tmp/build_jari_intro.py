from pathlib import Path
base = Path('C:/컴퓨터공학 종합설계')
p = base / 'jari-source.html'
s = p.read_text(encoding='utf-8')
s = s.replace("snoozeMinutes:5};", "snoozeMinutes:5,tourDone:false};")
s = s.replace("['vibration','visual'].forEach", "['vibration','visual','tourDone'].forEach")
s = s.replace("applyDesign();const offline", "root.dataset.tourDone=String(ui.tourDone);applyDesign();const offline")
s = s.replace("step++;if(active", "if(root.dataset.touring==='true')return;step++;if(active")
s = s.replace("restore(window.openai?.widgetState);", "root.addEventListener('jari:tour-complete',()=>{ui.tourDone=true;persist();});\n restore(window.openai?.widgetState);")
s = s.replace('MONDAY, SEPTEMBER 21','SIT WELL. WORK WELL.').replace('나의 착석 흐름','앉는 습관을 바꾸는 작은 신호').replace('작은 자세 변화와 휴식, 내 리듬에 맞게.','자세를 확인하고, 쉬어갈 때를 알려주는 나의 의자 코치.')
s = s.replace('기준 범위에 있어요','균형 있게 앉아 있어요').replace('<h2>지금 앉은 모습</h2>','<h2>자세 확인</h2>').replace('<h2>다음 휴식까지</h2>','<h2>휴식 타이밍</h2>').replace('>착석 상황<select','>상황 바꾸기<select').replace('가상 데이터 · 진동은 화면으로만 표현됩니다','시연용 가상 데이터 · 실제 아두이노 없이 동작하며 진동은 화면으로만 표현돼요.')
s += '\n' + (base / 'tmp/jari-intro.html').read_text(encoding='utf-8')
p.write_text(s,encoding='utf-8')
