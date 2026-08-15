import type { ValidationOutcome } from "@rivet/contracts";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { VALIDATION_OUTCOME_PRESENTATION } from "@/lib/validation-presentation";

/** Exhaustive sibling of StatusBadge for a validation comparison outcome. */
export function ValidationOutcomeBadge({
  outcome,
  className,
}: {
  outcome: ValidationOutcome;
  className?: string;
}) {
  const presentation = VALIDATION_OUTCOME_PRESENTATION[outcome];

  return (
    <Badge
      variant="outline"
      data-validation-outcome={outcome}
      className={cn(presentation.className, className)}
    >
      {presentation.label}
    </Badge>
  );
}
