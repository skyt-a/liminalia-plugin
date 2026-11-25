/** 「AI 相談」の欄の見た目。色・文字・線・角丸は制作画面の CSS の変数に揃える（暗い配色でも効く）。 */
export const STYLE = `
.lai { display: grid; gap: 8px; font-size: var(--fs-m); }
.lai-row { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.lai-spacer { flex: 1; }
.lai-status { display: flex; align-items: center; gap: 6px; font-size: var(--fs-s); color: var(--ink-soft); }
.lai-status-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lai-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--rule-strong); flex: none; }
.lai-dot.on { background: var(--ok); }
.lai-dot.off { background: var(--mark); }
.lai-settings { display: grid; gap: 6px; padding: 8px; border: var(--line) solid var(--rule); border-radius: var(--r-m); background: var(--paper); }
.lai-settings[hidden] { display: none; }
.lai-field { display: grid; gap: 2px; font-size: var(--fs-s); color: var(--ink-soft); }
.lai-field select, .lai-field input { width: 100%; }
.lai-hint { margin: 0; font-size: var(--fs-s); color: var(--ink-soft); word-break: break-all; }
.lai-target { font-size: var(--fs-s); color: var(--ink-soft); }
.lai-actions { display: flex; flex-wrap: wrap; gap: 4px; }
.lai-actions button { font-size: var(--fs-s); padding: 2px 8px; }
.lai-feed { display: grid; align-content: start; gap: 8px; max-height: 480px; min-height: 120px; overflow: auto; padding: 8px; border: var(--line) solid var(--rule); border-radius: var(--r-m); background: var(--paper); }
.lai-welcome { margin: 0; font-size: var(--fs-s); color: var(--ink-soft); }
.lai-msg { padding: 6px 8px; border-radius: var(--r-m); }
.lai-msg.user { justify-self: end; max-width: 90%; background: var(--cue-wash); }
.lai-msg.assistant { background: var(--sheet); }
.lai-msg.error { color: var(--mark); font-size: var(--fs-s); }
.lai-msg.pending .lai-text { color: var(--ink-soft); }
.lai-phase { font-size: var(--fs-s); color: var(--cue); margin-bottom: 4px; }
.lai-text { white-space: pre-wrap; word-break: break-word; line-height: 1.6; }
.lai-card { display: grid; gap: 6px; padding: 8px; border: var(--line) solid var(--rule); border-radius: var(--r-m); background: var(--sheet); }
.lai-card.applied { opacity: 0.6; }
.lai-card header { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.lai-badge { font-size: var(--fs-s); padding: 0 6px; border-radius: var(--r-s); background: var(--cue-wash); color: var(--cue); }
.lai-meta { margin-left: auto; font-size: var(--fs-s); color: var(--ink-soft); }
.lai-lim { margin: 0; padding: 8px; max-height: 240px; overflow: auto; white-space: pre-wrap; word-break: break-word; border-radius: var(--r-s); background: var(--paper); font-size: var(--fs-s); line-height: 1.6; }
.lai-warnings { margin: 0; padding-left: 18px; font-size: var(--fs-s); color: var(--mark); }
.lai-issues { margin: 0; padding-left: 0; list-style: none; display: grid; gap: 6px; font-size: var(--fs-s); }
.lai-issues li { display: grid; gap: 2px; padding-left: 8px; border-left: 3px solid var(--rule-strong); }
.lai-issues li.error { border-color: var(--mark); }
.lai-issues li.warning { border-color: var(--cue); }
.lai-line { justify-self: start; padding: 0 4px; font-size: var(--fs-s); }
.lai-input { width: 100%; resize: vertical; font: inherit; }
`;
