# Mermaid rendering — generic fence-renderer contract

> Status: IMPLEMENTED 2026-07-29 trên branch `app/mermaid-fence-renderer`. Quyết định chi tiết: `docs/DECISIONS.md` entry 2026-07-29.

## Vấn đề

OMP threads emit ` ```mermaid ` blocks thường xuyên — system prompt của engine
(`src/prompts/system/system-prompt.md:19-21` trong tarball 17.1.3) chủ động khuyến
khích model vẽ diagram bằng mermaid fence khi `renderMermaid` bật (default `true`;
sidecar không override). ADE hiện render fence này như code block thường
(shiki) — user thấy raw mermaid text thay vì diagram.

## Contract quyết định: fence TRONG MARKDOWN là contract, không phải event

Điểm mấu chốt của "generic contract để phù hợp từng engine":

**Tầng 1 — wire contract (engine-agnostic, đã tồn tại):** mọi engine (OMP, pi,
codex, claude, cursor, …) giao diagram qua fenced code block ` ```<lang> ` trong
assistant markdown. Không thêm provider event type, không đổi `packages/contracts`,
không sửa adapter nào. Engine mới = zero integration cost.

**Tầng 2 — render contract (web, phần ta build):** một _fence renderer registry_
trong `apps/web`: map `language → renderer`. Mermaid là entry đầu tiên; sau này
graphviz/dot, vega-lite, svg… chỉ là thêm entry, không đụng ChatMarkdown core.

**Tầng 3 — normalize rule (chỉ khi cần, hiện chưa cần):** engine nào phát diagram
qua kênh khác (tool-result payload riêng, extension UI widget) thì adapter của nó
normalize về markdown fence trước khi vào transcript. OMP: không cần gì cả —
engine đã emit fence sẵn.

Lý do chọn hướng này thay vì các phương án khác đã cân nhắc:

| Phương án                                       | Bỏ vì                                                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Provider event mới `diagram` + contracts schema | Đụng `packages/contracts` + mọi adapter; engine chưa engine nào phát diagram ngoài markdown → YAGNI          |
| Render ở sidecar/server (SVG server-side)       | Nặng (headless browser hoặc mermaid-cli), sai layer — render là presentation concern; theme phụ thuộc client |
| Extension UI widget qua bridge                  | Chỉ phủ OMP, không generic; bridge là cho _interactive_ UI, diagram là content tĩnh                          |

## Thiết kế

### Vị trí hook — một chỗ duy nhất

`ChatMarkdown.tsx` `pre` override (dòng ~1131): sau `parseCodeFenceInfo`, tra
registry theo `fence.language`. Có renderer → render `RichFenceBlock`; không →
đường shiki như cũ. ChatMarkdown là choke-point của MessagesTimeline, PlanSidebar,
ProposedPlanCard, ToolCallDetailsDialog, WorkspaceFilePreview, PullRequestMarkdown
→ coverage miễn phí trên mọi surface.

### Module layout

```
apps/web/src/lib/fence-renderers/
├── registry.ts          # FenceRenderer interface + lookup (sync, nhẹ)
└── mermaid-renderer.ts  # lazy module: init, parse-gate, render→SVG string, cache
apps/web/src/components/
└── MermaidFenceBlock.tsx # Suspense component, dùng lại khuôn SuspenseShikiCodeBlock
```

Interface tối thiểu (đừng phình):

```ts
interface FenceRenderer {
  /** fence language tags claimed, e.g. ["mermaid"] */
  languages: readonly string[];
  /** lazy component; nhận { code, themeName, isStreaming } */
  Component: React.ComponentType<FenceRendererProps>;
}
```

### Các quyết định kỹ thuật

1. **Streaming**: khi `isStreaming` → giữ shiki code block như hiện tại; message
   settle → swap sang diagram. Không parse mermaid trên block dở dang (fail liên
   tục, tốn CPU). Cùng triết lý với shiki cache (`cache only when !isStreaming`).
   Không làm fence-closed detection trong stream — YAGNI.
2. **Bundle**: mermaid ~2MB min. Dynamic import theo đúng pattern
   `syntaxHighlightingModulePromise` — chỉ tải khi gặp mermaid fence đầu tiên.
   KHÔNG import mermaid tĩnh ở bất kỳ đâu.
3. **Security**: `mermaid.initialize({ securityLevel: "strict", startOnLoad: false })`.
   Không bao giờ `"loose"`. Strict mode sanitize labels + chặn click/script.
   SVG inject qua `dangerouslySetInnerHTML` (cùng mức tin cậy với shiki HTML path).
4. **Theme**: `theme: resolvedTheme === "dark" ? "dark" : "neutral"` (+ có thể map
   CSS vars sau). Theme nằm trong cache key → đổi theme re-render đúng.
5. **Validate trước render**: `await mermaid.parse(code)` → invalid thì fallback
   im lặng về shiki code block (agent sinh mermaid lỗi là chuyện thường; không
   được vỡ layout, không toast). Error boundary bọc ngoài bắt lỗi runtime còn lại.
6. **Cache**: SVG string cache keyed `(code, theme)`, module-level Map + LRU cap
   giống `syntaxHighlighting` cache — transcript perf guardrails (SYNARA-AGENTS)
   yêu cầu re-render rẻ; mermaid layout (dagre) đắt.
7. **Render API**: `mermaid.render(id, code)` → SVG string thuần. Không dùng
   `mermaid.run()` (mutate DOM ngoài React ownership).
8. **UI v1**: tái dùng `MarkdownCodeBlock` header (lang label + copy source) +
   một `IconButton` toggle "diagram ↔ source". Default = diagram khi valid.
   SVG: `max-width: 100%`, overflow-x scroll cho flowchart LR rộng.

### Out of scope v1 (ghi để khỏi resurrect nhầm thứ tự)

- Zoom/pan, export PNG/SVG, click-to-expand dialog (cân nhắc v1.5 — có sẵn khuôn
  `ExpandedImagePreview`; chat column hẹp nên expand sẽ hữu ích sớm).
- Render file `.mmd` trong file viewer.
- Setting bật/tắt render (OMP có `tui.renderMermaid`; ADE thêm setting khi có nhu cầu thật).
- Sửa wording prompt OMP ("terminal renders it as ASCII" — sai ngữ cảnh web nhưng vô hại).
- Renderer thứ hai (dot/vega) — chỉ để chứng minh registry, không cần ngay.

## Phases

### Phase 1 — Registry + mermaid renderer module

- `fence-renderers/registry.ts`: interface + `getFenceRenderer(language)`.
- `mermaid-renderer.ts`: lazy import, initialize strict, parse-gate, render→SVG,
  cache (code, theme), LRU cap.
- `MermaidFenceBlock.tsx`: Suspense + error-boundary fallback về shiki child.
- Unit tests: registry lookup; invalid mermaid → fallback; cache hit path.

### Phase 2 — ChatMarkdown hook + toggle UI

- `pre` override: tra registry khi `!isStreaming`; pass shiki block làm fallback
  children.
- `MarkdownCodeBlock`: prop mở rộng cho toggle button (diagram/source state).
- Giữ nguyên 100% hành vi fence khác (file-reference fences, cursor ranges).

### Phase 3 — Verify

- `bun run test` (Vitest) cho unit mới; 35 web test fail sẵn có (upstream) không
  tính là regression.
- E2E smoke trong dev instance isolated: OMP thread, yêu cầu model vẽ flowchart →
  thấy SVG; mermaid cố tình lỗi → thấy code block; toggle hoạt động; dark/light.
- Transcript dài nhiều diagram: scroll không jank (spot-check profiler).
- Chốt task: `bun fmt && bun lint && bun typecheck`.

### Phase 4 — Docs

- `docs/DECISIONS.md`: append entry "fence-renderer contract" (wire contract =
  markdown fence; registry ở web; normalize rule cho engine lệch chuẩn).
- `docs/STATE.md`: một dòng trong milestone nếu ship.

## Câu hỏi mở — ĐÃ CHỐT (2026-07-29, user)

1. Default hiển thị: **diagram luôn** khi valid; toggle về source trong header.
2. Expand dialog: **vào v1** (dùng Base UI `Dialog`, không cần khuôn
   `ExpandedImagePreview`); inline cap chiều cao `min(60vh, 26rem)` + SVG scale
   theo column (`useMaxWidth`) để luôn fit màn hình.
3. Pin **exact `mermaid@11.16.0`** — OMP không dùng npm mermaid (ASCII renderer
   tự viết trong `@oh-my-pi/pi-utils`), nên không có version engine để align.

## Kết quả verify (2026-07-29)

- Unit: 30/30 pass (`mermaidRendering.test.ts`, `fenceRenderers.test.ts`,
  `ChatMarkdown.test.tsx` — routing + streaming gate).
- Browser (real mermaid, real Chromium — `ChatMarkdown.mermaid.browser.tsx`):
  SVG inline render, toggle diagram↔source, expand dialog, invalid → fallback
  code block. 4/4 pass. Thay thế E2E dev-instance smoke: cùng component, cùng
  CSS, cùng bundle path; đồng thời là regression test vĩnh viễn.
- `bun fmt` + `bun lint` (0 errors) + `bun typecheck` (8/8 packages) pass.
- `mermaid` thêm vào `optimizeDeps.include` (vite) để lần render đầu trong dev
  không trigger optimizer reload.
