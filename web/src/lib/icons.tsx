/**
 * Central icon module — the whole app's icons in one place, so the set is
 * swappable/reversible here alone. Icons are ICONCINO (CC0, vendored SVGs in
 * web/src/assets/iconcino); the two bookmark variants have no ICONCINO match
 * and stay lucide. Call sites (`<Icon {...ICON} />`) never change.
 *
 * Icon rules: 18px glyph, true 1.5px stroke, centered in a 24px box. ICONCINO
 * SVGs draw at stroke-width 2 in a 24px viewBox, so at 18px the stroke renders
 * at exactly 1.5px (2 × 18/24) — matching the old lucide `absoluteStrokeWidth`.
 */

import type { FC, SVGProps } from 'react'

import ActivitySvg from '../assets/iconcino/activity.svg?react'
import ArrowLeftSvg from '../assets/iconcino/arrow-left.svg?react'
import ArrowLeftRightSvg from '../assets/iconcino/arrow-left-right.svg?react'
import ArrowRightSvg from '../assets/iconcino/arrow-right.svg?react'
import BookmarkSvg from '../assets/iconcino/bookmark.svg?react'
import CheckSvg from '../assets/iconcino/check.svg?react'
import ChevronDownSvg from '../assets/iconcino/chevron-down.svg?react'
import ChevronLeftSvg from '../assets/iconcino/chevron-left.svg?react'
import ChevronRightSvg from '../assets/iconcino/chevron-right.svg?react'
import CloudSvg from '../assets/iconcino/cloud.svg?react'
import FileJsonSvg from '../assets/iconcino/file-json.svg?react'
import FlaskConicalSvg from '../assets/iconcino/flask-conical.svg?react'
import HardDriveSvg from '../assets/iconcino/hard-drive.svg?react'
import ImageUpSvg from '../assets/iconcino/image-up.svg?react'
import ImagesSvg from '../assets/iconcino/images.svg?react'
import KeyRoundSvg from '../assets/iconcino/key-round.svg?react'
import Link2Svg from '../assets/iconcino/link2.svg?react'
import ListChecksSvg from '../assets/iconcino/list-checks.svg?react'
import Maximize2Svg from '../assets/iconcino/maximize2.svg?react'
import MonitorSvg from '../assets/iconcino/monitor.svg?react'
import MonitorSmartphoneSvg from '../assets/iconcino/monitor-smartphone.svg?react'
import MoonSvg from '../assets/iconcino/moon.svg?react'
import MoveRightSvg from '../assets/iconcino/move-right.svg?react'
import NotebookPenSvg from '../assets/iconcino/notebook-pen.svg?react'
import OctagonXSvg from '../assets/iconcino/octagon-x.svg?react'
import PencilSvg from '../assets/iconcino/pencil.svg?react'
import PlaySvg from '../assets/iconcino/play.svg?react'
import PlusSvg from '../assets/iconcino/plus.svg?react'
import RefreshCwSvg from '../assets/iconcino/refresh-cw.svg?react'
import RotateCcwSvg from '../assets/iconcino/rotate-ccw.svg?react'
import SearchSvg from '../assets/iconcino/search.svg?react'
import ShieldCheckSvg from '../assets/iconcino/shield-check.svg?react'
import SparklesSvg from '../assets/iconcino/sparkles.svg?react'
import StoreSvg from '../assets/iconcino/store.svg?react'
import SunSvg from '../assets/iconcino/sun.svg?react'
import Trash2Svg from '../assets/iconcino/trash2.svg?react'
import TriangleAlertSvg from '../assets/iconcino/triangle-alert.svg?react'
import Undo2Svg from '../assets/iconcino/undo2.svg?react'
import UnplugSvg from '../assets/iconcino/unplug.svg?react'
import UploadCloudSvg from '../assets/iconcino/upload-cloud.svg?react'
import Wand2Svg from '../assets/iconcino/wand2.svg?react'
import WorkflowSvg from '../assets/iconcino/workflow.svg?react'
import XSvg from '../assets/iconcino/x.svg?react'

// No ICONCINO equivalent — kept on lucide.
export { BookmarkCheck, BookmarkPlus, Box, Crop, Download, LayoutGrid, List, Rows3, Settings } from 'lucide-react'

/** lucide-compatible props so existing `<Icon {...ICON} />` call sites work unchanged. */
type IconProps = SVGProps<SVGSVGElement> & {
  size?: number | string
  /** Accepted for lucide compatibility; ICONCINO SVGs carry their own stroke. */
  strokeWidth?: number | string
  absoluteStrokeWidth?: boolean
}

/** Render a vendored ICONCINO SVG sized/colored like the lucide icon it replaces. */
function iconcino(Svg: FC<SVGProps<SVGSVGElement>>): FC<IconProps> {
  return function Icon({ size = 18, strokeWidth: _sw, absoluteStrokeWidth: _asw, ...rest }) {
    return <Svg width={size} height={size} {...rest} />
  }
}

export const Activity = iconcino(ActivitySvg)
export const ArrowLeft = iconcino(ArrowLeftSvg)
export const ArrowLeftRight = iconcino(ArrowLeftRightSvg)
export const ArrowRight = iconcino(ArrowRightSvg)
export const Bookmark = iconcino(BookmarkSvg)
export const Check = iconcino(CheckSvg)
export const ChevronDown = iconcino(ChevronDownSvg)
export const ChevronLeft = iconcino(ChevronLeftSvg)
export const ChevronRight = iconcino(ChevronRightSvg)
export const Cloud = iconcino(CloudSvg)
export const FileJson = iconcino(FileJsonSvg)
export const FlaskConical = iconcino(FlaskConicalSvg)
export const HardDrive = iconcino(HardDriveSvg)
export const ImageUp = iconcino(ImageUpSvg)
export const Images = iconcino(ImagesSvg)
export const KeyRound = iconcino(KeyRoundSvg)
export const Link2 = iconcino(Link2Svg)
export const ListChecks = iconcino(ListChecksSvg)
export const Maximize2 = iconcino(Maximize2Svg)
export const Monitor = iconcino(MonitorSvg)
export const MonitorSmartphone = iconcino(MonitorSmartphoneSvg)
export const Moon = iconcino(MoonSvg)
export const MoveRight = iconcino(MoveRightSvg)
export const NotebookPen = iconcino(NotebookPenSvg)
export const OctagonX = iconcino(OctagonXSvg)
export const Pencil = iconcino(PencilSvg)
export const Play = iconcino(PlaySvg)
export const Plus = iconcino(PlusSvg)
export const RefreshCw = iconcino(RefreshCwSvg)
export const RotateCcw = iconcino(RotateCcwSvg)
export const Search = iconcino(SearchSvg)
export const ShieldCheck = iconcino(ShieldCheckSvg)
export const Sparkles = iconcino(SparklesSvg)
export const Store = iconcino(StoreSvg)
export const Sun = iconcino(SunSvg)
export const Trash2 = iconcino(Trash2Svg)
export const TriangleAlert = iconcino(TriangleAlertSvg)
export const Undo2 = iconcino(Undo2Svg)
export const Unplug = iconcino(UnplugSvg)
export const UploadCloud = iconcino(UploadCloudSvg)
export const Wand2 = iconcino(Wand2Svg)
export const Workflow = iconcino(WorkflowSvg)
export const X = iconcino(XSvg)

export const ICON = { size: 18, strokeWidth: 1.5, absoluteStrokeWidth: true } as const

/** 24px bounding box for an icon. */
export function IconBox({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={`flex size-6 shrink-0 items-center justify-center ${className ?? ''}`}>
      {children}
    </span>
  )
}
