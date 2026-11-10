import { SCENARIOS } from "@fle/run";
import { notFound } from "next/navigation";
import { runEnabled } from "../../../../lib/run-save";
import { lessonView } from "../../../../lib/study-view";
import { StudyScreen } from "../../study-screen";

/** The Run switch is read per request, so the "Practise this" link never points at a 404. */
export const dynamic = "force-dynamic";

export default async function LessonPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const lesson = lessonView(slug);
  if (!lesson) notFound();
  // Suggested starting point: the first one whose ideas include this lesson's concept.
  const start = SCENARIOS.find((s) => (s.teaches as readonly string[]).includes(lesson.conceptId));
  const practiseHref = runEnabled() ? (start ? `/run?start=${start.id}` : "/run") : null;
  return <StudyScreen mode="lesson" lesson={lesson} practiseHref={practiseHref} />;
}
