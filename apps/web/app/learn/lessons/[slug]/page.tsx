import { notFound } from "next/navigation";
import { lessonView } from "../../../../lib/study-view";
import { StudyScreen } from "../../study-screen";
export default async function LessonPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const lesson = lessonView(slug);
  if (!lesson) notFound();
  return <StudyScreen mode="lesson" lesson={lesson} />;
}
