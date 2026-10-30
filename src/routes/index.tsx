import { createFileRoute } from "@tanstack/react-router";
import { CutlineApp } from "@/components/cutline-app";

export const Route = createFileRoute("/")({ component: CutlineApp });
