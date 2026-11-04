import { test, expect } from "bun:test";
import { inlineMath } from "./inline-math";

test("inline TeX between single dollars becomes math; prices, variables and code don't", () => {
  expect(inlineMath("It grows as $O(n \\log n)$, fine.")).toBe("It grows as $$O(n \\log n)$$, fine.");
  expect(inlineMath("where $x^2 + y_1$ holds")).toBe("where $$x^2 + y_1$$ holds");
  expect(inlineMath("It costs $5 and $10 a month.")).toBe("It costs $5 and $10 a month.");
  expect(inlineMath("Between $5 and $10")).toBe("Between $5 and $10");
  expect(inlineMath("Use `$x^2$` literally")).toBe("Use `$x^2$` literally");
  expect(inlineMath("```\n$a_1$\n```\nthen $a_1$")).toBe("```\n$a_1$\n```\nthen $$a_1$$");
  expect(inlineMath("$$\\sum_i i$$ stays")).toBe("$$\\sum_i i$$ stays");
  expect(inlineMath("Set $HOME_DIR and $PATH_X")).toBe("Set $HOME_DIR and $PATH_X");
  expect(inlineMath("from $A_1$ to $B_2$")).toBe("from $$A_1$$ to $$B_2$$");
});
