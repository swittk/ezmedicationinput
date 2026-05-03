import { describe, expect, it } from "vitest";
import { filterLocalizedWhenEvents } from "../src/localized-timing";
import { EventTiming } from "../src/types";

describe("filterLocalizedWhenEvents", () => {
  it("keeps generic meal markers unless all three specific meal timings exist", () => {
    expect(
      filterLocalizedWhenEvents({
        when: [EventTiming["After Meal"], EventTiming["After Breakfast"], EventTiming["After Lunch"]]
      })
    ).toEqual([EventTiming["After Meal"], EventTiming["After Breakfast"], EventTiming["After Lunch"]]);

    expect(
      filterLocalizedWhenEvents({
        when: [EventTiming["Before Meal"], EventTiming["Before Breakfast"], EventTiming["Before Dinner"]]
      })
    ).toEqual([EventTiming["Before Meal"], EventTiming["Before Breakfast"], EventTiming["Before Dinner"]]);

    expect(
      filterLocalizedWhenEvents({
        when: [EventTiming.Meal, EventTiming.Breakfast, EventTiming.Dinner]
      })
    ).toEqual([EventTiming.Meal, EventTiming.Breakfast, EventTiming.Dinner]);
  });

  it("drops generic meal markers when breakfast, lunch, and dinner variants are all present", () => {
    expect(
      filterLocalizedWhenEvents({
        when: [
          EventTiming["After Meal"],
          EventTiming["After Breakfast"],
          EventTiming["After Lunch"],
          EventTiming["After Dinner"]
        ]
      })
    ).toEqual([
      EventTiming["After Breakfast"],
      EventTiming["After Lunch"],
      EventTiming["After Dinner"]
    ]);

    expect(
      filterLocalizedWhenEvents({
        when: [
          EventTiming["Before Meal"],
          EventTiming["Before Breakfast"],
          EventTiming["Before Lunch"],
          EventTiming["Before Dinner"]
        ]
      })
    ).toEqual([
      EventTiming["Before Breakfast"],
      EventTiming["Before Lunch"],
      EventTiming["Before Dinner"]
    ]);

    expect(
      filterLocalizedWhenEvents({
        when: [EventTiming.Meal, EventTiming.Breakfast, EventTiming.Lunch, EventTiming.Dinner]
      })
    ).toEqual([EventTiming.Breakfast, EventTiming.Lunch, EventTiming.Dinner]);
  });
});
