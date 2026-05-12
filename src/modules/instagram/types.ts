/**
 * instagram module — domain types.
 * All Instagram-specific interfaces consolidated here.
 */

// ── Cut Engine types ────────────────────────────────────────────────────────

export interface CutSegment {
  source: string;      // Dateiname in original/
  start_s: number;
  end_s: number;
}

export interface CutPlan {
  output_file: string;
  segments: CutSegment[];
  transitions?: 'none' | 'fade';
}

export type InstaFormat = 'reel' | 'feed-video' | 'feed-photo';

export interface CutResult {
  output_path: string;
  duration_s: number;
  format: InstaFormat | 'raw';
  file_size: number;
  segments_used: number;
}

export interface VideoProbe {
  duration_s: number;
  width: number;
  height: number;
  codec: string;
  fps: number;
  has_audio: boolean;
}

// ── Scan / Craft Engine types ───────────────────────────────────────────────

export interface FileAnalysis {
  fileName: string;
  type: 'image' | 'video';
  analysis: import('../../../instagram-content-engine.js').VisionAnalysis;
  duration_s?: number;
  probe?: VideoProbe;
}

export interface ContentProposal {
  id: string;                    // "A", "B", "C"
  format: InstaFormat;
  title: string;
  rationale: string;
  pillar_match: string[];
  cut_plan?: CutPlan;           // nur bei Video-Vorschlägen
  source_files: string[];
  estimated_duration_s?: number;
}

export interface ScanResult {
  scanned_at: string;
  file_analyses: FileAnalysis[];
  proposals: ContentProposal[];
  selected_proposal?: string;
}

export interface CraftDialogState {
  sessionId: string;
  direction: string;
  currentPlan?: ContentProposal;
  fileAnalyses?: FileAnalysis[];
  step: 'awaiting_direction' | 'generating' | 'plan_ready' | 'adjusting' | 'executing';
  expiresAt: number;
}

// ── Raw Session types ───────────────────────────────────────────────────────

export interface RawSessionFile { name: string; size: number; type: 'image' | 'video' | 'document'; addedAt: string }
export interface RawSession {
  id: string;
  created_at: string;
  mode: 'upload';
  status: 'active' | 'closed' | 'scanning' | 'scanned' | 'crafting' | 'cutting' | 'cut_done';
  files: RawSessionFile[];
  cut_plan?: CutPlan;
  cut_result?: CutResult;
  scan_result?: ScanResult;
}
