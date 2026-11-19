# DUO UI visual system

Based on Apple Human Interface Guidelines layout and progressive disclosure:
https://developer.apple.com/design/human-interface-guidelines/layout

- Pretendard Variable 1.3.9 is bundled as a same-origin WOFF2 asset for offline use. Its OFL license is included in third-party notices.
- Grouped backgrounds, rounded surfaces, blue actions and clear title hierarchy.
- Direction starts with four counts. Original documents, requirements and constraints expand on request. Decision titles and states stay visible; questions and sources use disclosures.
- Empty milestones and historical decisions start collapsed.
- Shared cards, controls, dialogs and responsive navigation use the same tokens. Appearance follows OS light and dark preferences.
- New strings remain in bundled English and Korean catalogs.

DUO uses web components; native Apple components and SF Symbols are not bundled.
The local font asset is approximately 2.0 MB. No font CDN requests are made.

The production Work map and Graph explorer remain available. The experimental `/session-preview` page shows only explicitly recorded changed and referenced file connections and is labeled as a preview.

Analysis coverage remains available through its navigation link and the dedicated `/coverage` page, with the original coverage table. Overview also includes a collapsed coverage detail and an always-visible indexed file count. The Context compiler remains available at `/context`. The session preview displays optional recorded provided context separately from referenced files and does not infer that delivered information was read. Its preview notice is translated into English and Korean. The demo supplies simulated records. Production capture of these records is not yet wired.
