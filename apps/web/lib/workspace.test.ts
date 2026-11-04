import { test, expect } from "bun:test";
import { focusedSession, normalize, panes, workspace, type Split } from "./workspace";

const layout = () => workspace.get();
const shape = () => {
  const show = (n: ReturnType<typeof layout>["root"]): unknown =>
    n.kind === "pane" ? n.tabs.map((t) => (t === n.active ? `*${t}` : t)).join(",") || "(empty)" : { [n.dir]: n.children.map(show) };
  return show(layout().root);
};

test("sessions open as tabs, split, move by dropping, resize and close", () => {
  workspace.open("a");
  workspace.open("b");
  expect(shape()).toBe("a,*b");
  // Opening one that's already open goes to it.
  workspace.open("a");
  expect(shape()).toBe("*a,b");
  expect(focusedSession(layout())).toBe("a");

  // Split right: an empty pane, focused, kept while it's waiting for a session.
  const left = layout().focus;
  workspace.split(left, "right");
  expect(shape()).toEqual({ row: ["*a,b", "(empty)"] });
  expect(focusedSession(layout())).toBe(null);
  // Dropping a tab into it moves the session there.
  workspace.drop("b", layout().focus, {});
  expect(shape()).toEqual({ row: ["*a", "*b"] });

  // Dropping on a pane's bottom edge splits it downward.
  workspace.open("c");
  const right = layout().focus;
  workspace.drop("c", right, { edge: "bottom" });
  expect(shape()).toEqual({ row: ["*a", { column: ["*b", "*c"] }] });

  // Beside a pane in a split of the same direction: a sibling sharing that pane's room.
  workspace.openBeside("d", "right");
  const root = layout().root as Split;
  expect(shape()).toEqual({ row: ["*a", { column: ["*b", { row: ["*c", "*d"] }] }] });

  // Resizing changes the shares, which stay summed to one.
  workspace.resize(root.id, [0.3, 0.7]);
  expect((layout().root as Split).sizes).toEqual([0.3, 0.7]);

  // Closing the last tab of a pane removes the pane.
  const dPane = panes(layout().root).find((p) => p.tabs.includes("d"))!;
  workspace.close(dPane.id, "d");
  expect(shape()).toEqual({ row: ["*a", { column: ["*b", "*c"] }] });

  // Forgetting a session (deleted) closes it everywhere.
  workspace.forget("b");
  expect(shape()).toEqual({ row: ["*a", "*c"] });
  workspace.closePane(panes(layout().root).find((p) => p.tabs.includes("c"))!.id);
  expect(shape()).toBe("*a");
});

test("a tidy tree: empty panes go, and nested splits of one direction flatten with their shares", () => {
  const flat = normalize({
    focus: "p1",
    root: {
      kind: "split", id: "s1", dir: "row", sizes: [0.5, 0.5],
      children: [
        { kind: "pane", id: "p1", tabs: ["a"], active: "a" },
        { kind: "split", id: "s2", dir: "row", sizes: [0.4, 0.6], children: [{ kind: "pane", id: "p2", tabs: ["b"], active: "b" }, { kind: "pane", id: "p3", tabs: ["c"], active: "c" }] },
      ],
    },
  });
  expect((flat.root as Split).children.map((c) => c.id)).toEqual(["p1", "p2", "p3"]);
  expect((flat.root as Split).sizes.map((x) => Math.round(x * 100))).toEqual([50, 20, 30]);

  const l = normalize({
    focus: "p1",
    root: {
      kind: "split", id: "s1", dir: "row", sizes: [0.5, 0.5],
      children: [
        { kind: "pane", id: "p1", tabs: ["a"], active: "a" },
        { kind: "split", id: "s2", dir: "row", sizes: [0.5, 0.5], children: [{ kind: "pane", id: "p2", tabs: ["b"], active: null }, { kind: "pane", id: "p3", tabs: [], active: null }] },
      ],
    },
  });
  const root = l.root as Split;
  // p3 was empty and not focused: gone. p2 takes its room (its split's half), and gets an active tab.
  expect(root.children.map((c) => c.id)).toEqual(["p1", "p2"]);
  expect(root.sizes).toEqual([0.5, 0.5]);
  expect(panes(root)[1]!.active).toBe("b");
});
