"use client";

import { LandingSearch, type LandingSearchProps } from "./alternative-dates";

export default function MissionDateSearch(props: Omit<LandingSearchProps, "planner"> & { coverageStart: string; coverageEnd: string }) {
  return <LandingSearch key={[props.runId, props.from, props.to, props.initialSiteId, props.initialMissionHours, props.initialObjective].join("/")} planner {...props} />;
}
