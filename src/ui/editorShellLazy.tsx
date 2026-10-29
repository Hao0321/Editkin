import { lazy, memo } from "react";

// PF1 (2026-10-23): the four main panels are React.memo boundaries. They skip a shell render whose props they share
// (playhead ticks and seeks no longer reach the shell at all; see playheadStore.ts).

export const FirstProjectStart = lazy(() => import("./FirstProjectStart").then((module) => ({ default: module.FirstProjectStart })));
export const MobileConnectModal = lazy(() => import("./MobileConnectModal").then((module) => ({ default: module.MobileConnectModal })));
export const BatchAutoEditPanel = lazy(() => import("./BatchAutoEditPanel").then((module) => ({ default: module.BatchAutoEditPanel })));
export const ColorWorkspace = lazy(() => import("./ColorWorkspace").then((module) => ({ default: module.ColorWorkspace })));
export const Inspector = lazy(() => import("./Inspector").then((module) => ({ default: memo(module.Inspector) })));
export const EditingProfilePicker = lazy(() => import("./EditingProfilePicker").then((module) => ({ default: module.EditingProfilePicker })));
export const AgentPanel = lazy(() => import("./AgentPanel").then((module) => ({ default: module.AgentPanel })));
export const Preview = lazy(() => import("./Preview").then((module) => ({ default: memo(module.Preview) })));
export const BeginnerGuide = lazy(() => import("./BeginnerGuide").then((module) => ({ default: module.BeginnerGuide })));
export const MediaBin = lazy(() => import("./MediaBin").then((module) => ({ default: memo(module.MediaBin) })));
export const Timeline = lazy(() => import("./Timeline").then((module) => ({ default: memo(module.Timeline) })));
export const WorkspaceDropImport = lazy(() => import("./WorkspaceDropImport").then((module) => ({ default: module.WorkspaceDropImport })));
export const AgentConnectModal = lazy(() => import("./AgentConnectModal").then((module) => ({ default: module.AgentConnectModal })));
export const AutoEditDialog = lazy(() => import("./AutoEditDialog").then((module) => ({ default: module.AutoEditDialog })));

export const BEGINNER_GUIDE_KEY = "editkin.beginner-guide.v1";
