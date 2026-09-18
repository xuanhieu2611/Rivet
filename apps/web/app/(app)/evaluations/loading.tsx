import { PageHeaderSkeleton, TableSkeleton } from "@/components/skeletons";

/** Matches the suites table: suite, status, matrix, success, started. */
export default function EvaluationsLoading() {
  return (
    <div className="space-y-6">
      <PageHeaderSkeleton />
      <TableSkeleton columns={["w-1/4", "w-20", "w-1/4", "w-24", "w-28"]} rows={4} />
    </div>
  );
}
