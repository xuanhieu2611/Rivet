import { PageHeaderSkeleton, TableSkeleton } from "@/components/skeletons";

/** Matches the jobs table: title, repository, status, created. */
export default function JobsLoading() {
  return (
    <div className="space-y-6">
      <PageHeaderSkeleton action />
      <div className="flex gap-1.5">
        {["w-12", "w-20", "w-24", "w-16"].map((width) => (
          <div key={width} className={`bg-muted h-7 rounded-md ${width} animate-pulse`} />
        ))}
      </div>
      <TableSkeleton columns={["w-1/3", "w-1/3", "w-24", "w-28"]} />
    </div>
  );
}
