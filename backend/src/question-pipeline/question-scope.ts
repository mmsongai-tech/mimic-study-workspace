import type { StudyFrame, StudyType } from "../study-framing/index.js";

/** Plain names of each kind of analysis, used in the reason an aim is outside the release's question scope. */
const KIND_NAMES: Record<StudyType, { en: string; zh: string }> = {
  descriptive: { en: "description", zh: "描述" },
  group_comparison: { en: "group comparison", zh: "组间比较" },
  association: { en: "a measure and an outcome", zh: "指标与结局" },
  treatment_effect: { en: "a treatment and an outcome", zh: "用药与结局" },
  time_to_event: { en: "time to event", zh: "生存分析" },
  longitudinal_change: { en: "change of a measure", zh: "指标的变化" },
  dose_response: { en: "dose-response", zh: "剂量-反应" },
  effect_modification: { en: "whether a subgroup or sex changes the effect", zh: "亚组或性别是否改变疗效" },
  mediation: { en: "mediation", zh: "中介分析" },
  prediction: { en: "prediction", zh: "预测" },
};

/** Whether an aim's study type is inside the release's question scope. */
export const inQuestionScope = (frame: StudyFrame, allowed: readonly StudyType[] | undefined): boolean => !allowed || allowed.includes(frame.study_type);

/**
 * The release's question scope, a rule on study types only (never on particular questions): an aim whose type is not
 * allowed is not planned. It stays among the unanswered aims with the reason first; the other aims are planned as usual.
 * `allowed` undefined means every type is allowed. Call it after every other rule has set each aim's status: the reason
 * says the rest is analysed only when another aim is in scope and ready. Frames saved by an earlier run (re-analysis,
 * `--from-run`) already carry the reason; it is replaced, never added twice.
 */
export const applyQuestionScope = (frames: StudyFrame[], allowed: readonly StudyType[] | undefined): void => {
  const outside = frames.filter((frame) => !inQuestionScope(frame, allowed));
  const rest = frames.some((frame) => inQuestionScope(frame, allowed) && frame.status === "ready");
  for (const frame of outside) {
    const kind = KIND_NAMES[frame.study_type];
    frame.status = "needs_clarification";
    frame.ambiguities = frame.ambiguities.filter(({ code }) => code !== "STUDY_TYPE_NOT_SUPPORTED");
    frame.ambiguities.unshift({
      code: "STUDY_TYPE_NOT_SUPPORTED",
      message: rest
        ? `This version does not support this kind of analysis (${kind.en}); the rest of the question is analysed as usual.`
        : `This version does not support this kind of analysis (${kind.en}). Choose one of the kinds of question this version supports and rewrite the question in its format.`,
      message_zh: rest
        ? `本版本暂不支持此类分析（${kind.zh}），其余部分照常分析。`
        : `本版本暂不支持此类分析（${kind.zh}）。请从本版本支持的问题类型中选一类，按格式改写后重新提交。`,
    });
  }
};
