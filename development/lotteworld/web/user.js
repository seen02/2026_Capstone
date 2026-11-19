const contractVersion = "recommendation.v1";
const signId = new URLSearchParams(location.search).get("sign_id") ?? "magic-island-west";
const character = document.querySelector("#character");
const characterId = document.querySelector("#character-id");
const characterPosition = document.querySelector("#character-position");
const status = document.querySelector("#status");
const retry = document.querySelector("#retry");
const preferences = document.querySelector("#preferences");
const controls = document.querySelector("#controls");
const list = document.querySelector("#facility-order");
let state;
let order;

async function request(path, method, body) {
  const response = await fetch(`/api/user/${path}`, {
    method,
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({contract_version: contractVersion, ...body}),
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("서버 응답을 읽을 수 없습니다. 다시 시도해 주세요.");
  }
  if (!response.ok) {
    throw new Error(data?.error?.message ?? "요청을 처리할 수 없습니다. 다시 시도해 주세요.");
  }
  return data;
}

function showStatus(message, error = false) {
  status.textContent = message;
  status.toggleAttribute("data-error", error);
}

function renderOrder() {
  const names = new Map(state.facilities.map(facility => [facility.facility_id, facility.name]));
  list.replaceChildren(...order.map((facilityId, index) => {
    const name = names.get(facilityId);
    const row = document.createElement("li");
    const rank = document.createElement("span");
    rank.className = "rank";
    rank.textContent = `${index + 1}순위`;
    const label = document.createElement("span");
    label.className = "facility-name";
    label.textContent = name;
    const moves = document.createElement("div");
    moves.className = "moves";

    for (const [direction, icon, action] of [[-1, "↑", "올리기"], [1, "↓", "내리기"]]) {
      const button = document.createElement("button");
      const next = index + direction;
      button.type = "button";
      button.textContent = icon;
      button.setAttribute("aria-label", `${name} 순위 ${action}`);
      button.disabled = next < 0 || next >= order.length;
      button.addEventListener("click", () => {
        [order[index], order[next]] = [order[next], order[index]];
        renderOrder();
        const buttons = Array.from(list.children[next].querySelectorAll("button"));
        const sameDirection = buttons[direction < 0 ? 0 : 1];
        (sameDirection.disabled ? buttons.find(item => !item.disabled) : sameDirection).focus();
        showStatus("순위를 변경했습니다. 선호를 저장해 주세요.");
      });
      moves.append(button);
    }
    row.append(rank, label, moves);
    return row;
  }));
}

async function connect() {
  retry.hidden = true;
  showStatus("가상 캐릭터를 연결하는 중입니다.");
  try {
    state = await request("session", "POST", {sign_id: signId});
    const {session, facilities} = state;
    characterId.textContent = session.character_id;
    characterPosition.textContent = `시뮬레이션 속 내 위치 (${session.position.point.join(", ")}) m`;
    order = session.preference_order.length
      ? [...session.preference_order]
      : facilities.map(facility => facility.facility_id);
    renderOrder();
    character.hidden = false;
    preferences.hidden = false;
    showStatus(session.phase === "ready" ? "저장한 선호 순위를 불러왔습니다." : "아직 저장한 선호 순위가 없습니다.");
  } catch (error) {
    showStatus(error instanceof TypeError ? "서버에 연결할 수 없습니다. 다시 시도해 주세요." : error.message, true);
    retry.hidden = false;
  }
}

preferences.addEventListener("submit", async event => {
  event.preventDefault();
  controls.disabled = true;
  showStatus("선호 순위를 저장하는 중입니다.");
  try {
    state = await request("preferences", "PUT", {
      context: state.context,
      session_id: state.session.session_id,
      expected_revision: state.session.revision,
      preference_order: order,
    });
    showStatus("선호 순위를 저장했습니다.");
  } catch (error) {
    showStatus(error instanceof TypeError ? "서버에 연결할 수 없습니다. 다시 저장해 주세요." : error.message, true);
  } finally {
    controls.disabled = false;
  }
});

retry.addEventListener("click", connect);
connect();
