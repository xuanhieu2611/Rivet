import { CardSkeleton, PageHeaderSkeleton, TableSkeleton } from "@/components/skeletons";

export default function EvaluationSuiteLoading() {
  return (
    <div className="space-y-8">
      <PageHeaderSkeleton />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((card) => (
          <CardSkeleton key={card} lines={2} />
        ))}
      </div>
      <TableSkeleton columns={["w-1/4", "w-24", "w-24", "w-20", "w-24"]} rows={8} />
    </div>
  );
}
