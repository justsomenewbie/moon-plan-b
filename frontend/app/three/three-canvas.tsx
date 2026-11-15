"use client";
import { useEffect, useRef } from "react";
import { startScene } from "./scene";

export default function ThreeCanvas() {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => host.current ? startScene(host.current) : undefined, []);
  return <div ref={host} className="three-backdrop" aria-hidden="true" />;
}
