import type { MotionDesignV3TemplateId } from "../../../domain/types";
import type { V3Template } from "../types";
import { chapterNumber } from "./chapter";
import { compareSplit, progressBar, statCounter } from "./data";
import { ctaSubscribe, highlightSweep, quoteCard, stepsList } from "./emphasis";
import { calloutLine, locationPin, tagPill } from "./labels";
import { lowerThirdBar, lowerThirdGlass } from "./lowerThirds";
import { titleEditorial, titleImpact, titleReveal } from "./titles";

const TEMPLATES: Record<MotionDesignV3TemplateId, V3Template> = {
  title_reveal: titleReveal,
  title_impact: titleImpact,
  title_editorial: titleEditorial,
  lower_third_bar: lowerThirdBar,
  lower_third_glass: lowerThirdGlass,
  chapter_number: chapterNumber,
  stat_counter: statCounter,
  progress_bar: progressBar,
  compare_split: compareSplit,
  tag_pill: tagPill,
  location_pin: locationPin,
  callout_line: calloutLine,
  highlight_sweep: highlightSweep,
  quote_card: quoteCard,
  steps_list: stepsList,
  cta_subscribe: ctaSubscribe,
};

export function motionV3Template(id: MotionDesignV3TemplateId): V3Template {
  const template = TEMPLATES[id];
  if (!template) throw new Error(`未知的 v3 版型：${id}`);
  return template;
}
