// Скользящее окно истории для запроса к LLM. Промпт растёт линейно весь звонок, и к
// фазе подтверждения заявки время до первого токена заметно пухнет. В модель шлём
// system + последние max сообщений; ПОЛНАЯ история остаётся у вызывающего кода —
// она нужна enforcePhoneGate (поиск телефона по всем репликам) и extractOrder в конце
// звонка. Окно начинаем с реплики клиента: срез, начавшийся с assistant, ломает
// чередование ролей после system.
export function windowForLlm(history, max = 16) {
  if (history.length <= max + 1) return history;
  const tail = history.slice(-max);
  if (tail[0]?.role === "assistant") tail.shift();
  return [history[0], ...tail];
}
