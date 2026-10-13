# SDD ledger — plan: docs/superpowers/plans/2026-10-12-snow.md

Ruling: 用户已确认设计并明确要求现在修改代码，直接执行，不重复索取批准。

Ruling: 主工程存在其他任务的未提交改动，采用当前文件的独立快照，在 workspace/terrain-snow-workshop 开发。用户追加要求完成后合入 V0.4.3；另一任务已完成，后续影像文档、runtime-check 与来源测试已按最新版本保留。最终仅应用积雪差异，并用原文件 SHA 防止覆盖新改动。初始快照提交是对方当时状态，不属于本功能改动。

Preflight: Task 1 produces materialParts and snow faceKinds; Task 2 consumes them. Task 3 duplicates public option fields in desktop types; Task 4 carries them across IPC. Files are owned separately. Baseline captured before feature edits; baseline and dependency copy completed before feature edits.

Task 1: implemented; 14 geometry regressions plus real generation tests pass. Covers exact disabled/zero path, summit coverage, smooth snowline, slope/exaggeration, full/flat/plateau/saddle terrain, curved footprints, volume interfaces, large noninteger dimensions and Float32 storage.
Task 2: implemented; independent 3MF/OBJ/PNG readback verifies closed material solids, white object-level base material, one identity assembly, four colors, hidden terrain classification and recoloring.
Task 3: implemented; setting validation, legacy recovery, persistent snow settings, stale state, fixed white preview and actual coverage/error display pass. Enabling snow switches atomically to four colors.
Task 4: complete; core 309 tests:306 pass,0 fail,3 existing Windows link skips; desktop167 tests:161 pass,0 fail,6 existing sandbox link skips. Desktop build successful. Real utilityProcess/renderer snow generation, 3MF/OBJ/STL save, recolor and session recovery pass. Original V0.4.3 imagery-source UI regression passes including12/24months,none/local,cancellation and recovery. Final 162-case stress matrix passes all exterior/material closedness, Float32, volume sum and coverage checks. Applied 41 feature files with source SHA guards; original imagery runtime-check and tests untouched. Merged source full build/suites pass. Packaged V0.4.3 EXE generated54,596-face closed model and exported all3formats; packaged renderer workflow passed;152 release code files match both isolated and original final builds. Previous release preserved. Target slicer and physical printing not yet tested.

Review fixes: canonicalized all snow solid coordinates to STL Float32 before validation/hash/publication; emitted enabled:true in both snow report producers; made coverage error visible to0.001 percentage point. A terrain/base seam of <=3e-6mm is resolved only in the snow branch. XY-distance snow taper prevents unprintable infinitesimal layers on wide near-flat foothills. Model budgets and strict closedness checks remain active.
