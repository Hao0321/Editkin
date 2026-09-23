import { lazy } from "react";

export const FirstProjectStart = lazy(() => import("./FirstProjectStart").then((module) => ({ default: module.FirstProjectStart })));
export const MobileConnectModal = lazy(() => import("./MobileConnectModal").then((module) => ({ default: module.MobileConnectModal })));
export const BatchAutoEditPanel = lazy(() => import("./BatchAutoEditPanel").then((module) => ({ default: module.BatchAutoEditPanel })));
export const ColorWorkspace = lazy(() => import("./ColorWorkspace").then((module) => ({ default: module.ColorWorkspace })));
export const DirectorConsole = lazy(() => import("./DirectorConsole").then((module) => ({ default: module.DirectorConsole })));
export const Inspector = lazy(() => import("./Inspector").then((module) => ({ default: module.Inspector })));
export const EditingProfilePicker = lazy(() => import("./EditingProfilePicker").then((module) => ({ default: module.EditingProfilePicker })));
export const AgentPanel = lazy(() => import("./AgentPanel").then((module) => ({ default: module.AgentPanel })));
export const Preview = lazy(() => import("./Preview").then((module) => ({ default: module.Preview })));
export const BeginnerGuide = lazy(() => import("./BeginnerGuide").then((module) => ({ default: module.BeginnerGuide })));
export const MediaBin = lazy(() => import("./MediaBin").then((module) => ({ default: module.MediaBin })));
export const Timeline = lazy(() => import("./Timeline").then((module) => ({ default: module.Timeline })));
export const WorkspaceDropImport = lazy(() => import("./WorkspaceDropImport").then((module) => ({ default: module.WorkspaceDropImport })));
export const AgentConnectModal = lazy(() => import("./AgentConnectModal").then((module) => ({ default: module.AgentConnectModal })));
export const AutoEditDialog = lazy(() => import("./AutoEditDialog").then((module) => ({ default: module.AutoEditDialog })));

export const BEGINNER_GUIDE_KEY = "editkin.beginner-guide.v1";
