import { assertStringIncludes, assertThrows } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { describeTimeout, groupStopProgram } from "./bounded-process.ts";

describe("groupStopProgram", () => {
  it("refuses a group id that would signal more than one group", () => {
    for (const group of [0, 1, -5, 2.5, Number.NaN, 2 ** 60]) {
      assertThrows(() => groupStopProgram(group, 1_000), RangeError);
    }
  });

  it("substitutes only the numeric group id and the grace bound", () => {
    const program = groupStopProgram(4242, 1_500.4);
    assertStringIncludes(program, "const group = 4242;");
    assertStringIncludes(program, "emptiesWithin(1500)");
  });
});

describe("describeTimeout", () => {
  it("reads as a plain kill when the runner gave no termination detail", () => {
    assertStringIncludes(describeTimeout(10), "timed out after 10ms (killed)");
  });
});
