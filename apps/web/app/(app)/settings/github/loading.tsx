import { CardSkeleton, PageHeaderSkeleton } from "@/components/skeletons";

export default function GitHubSettingsLoading() {
  return (
    <div className="space-y-6">
      <PageHeaderSkeleton action />
      <CardSkeleton lines={3} />
      <CardSkeleton lines={4} />
    </div>
  );
}
