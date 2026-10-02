export interface Course {
  key: string | number;
  at: string;
  kind: "status" | "text" | "tool_call" | "tool_result" | "raw" | "error" | "done" | "pr";
  body: string;
}

const KIND_LABEL: Record<Course["kind"], string> = {
  status: "Status",
  text: "Agent",
  tool_call: "Tool",
  tool_result: "Result",
  raw: "Event",
  error: "Error",
  done: "Turn done",
  pr: "Pull request",
};

export function Courses({ courses, animate = false }: { courses: Course[]; animate?: boolean }) {
  return (
    <ol className="courses">
      {courses.map((c) => (
        <li key={c.key} className={`course${animate ? " course-enter" : ""}`} data-kind={c.kind}>
          <span className="t num">{c.at}</span>
          <span className="k caps">{KIND_LABEL[c.kind]}</span>
          <span className="body">{c.body}</span>
        </li>
      ))}
    </ol>
  );
}
