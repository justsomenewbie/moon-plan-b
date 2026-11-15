import type { Metadata } from "next";
import NotFoundView from "./not-found-view";

export const metadata: Metadata = { title: "Page not found — Moon Plan B" };

export default function NotFound() { return <NotFoundView />; }
