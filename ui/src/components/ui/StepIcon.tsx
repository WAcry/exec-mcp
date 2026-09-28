import {
  BookOpen,
  Database,
  FileDiff,
  FileInput,
  FileOutput,
  Image,
  Keyboard,
  MessageCircleQuestion,
  Plug,
  SquareTerminal,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { StepKind } from "../../lib/steps";

const ICONS: Record<StepKind, LucideIcon> = {
  command: SquareTerminal,
  stdin: Keyboard,
  patch: FileDiff,
  question: MessageCircleQuestion,
  image: Image,
  export: FileOutput,
  import: FileInput,
  skills: BookOpen,
  resource: Database,
  mcp: Plug,
  tool: Wrench,
};

export function StepIcon({
  kind,
  className = "h-3.5 w-3.5",
}: {
  kind: StepKind;
  className?: string;
}) {
  const Icon = ICONS[kind];
  return <Icon className={className} strokeWidth={1.8} aria-hidden="true" />;
}
