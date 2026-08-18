// 工件类型与 URL 分类的唯一映射

export const ARTIFACT_CATEGORY_BY_KIND = {lesson: 'lessons', review: 'reviews', quiz: 'quizzes'} as const

export type ArtifactKind = keyof typeof ARTIFACT_CATEGORY_BY_KIND

export type ArtifactCategory = typeof ARTIFACT_CATEGORY_BY_KIND[ArtifactKind]

export function artifactKindOf(category: string | undefined): ArtifactKind | null {
  if (category === 'lessons') return 'lesson'
  if (category === 'reviews') return 'review'
  if (category === 'quizzes') return 'quiz'
  return null
}
