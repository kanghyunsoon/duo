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

The standalone Graph navigation and explorer are removed. Legacy `/graph` bookmarks render Session files. Session files retains its graph with only changed and explicitly referenced file connections. Entity details retain direct relation information without an explorer link.

Analysis coverage is a collapsed detail in Overview, with an always-visible indexed file count. The standalone Context navigation is removed; session details display recorded provided context in a collapsed section, separate from referenced files. Legacy `/coverage` opens Overview and `/context` opens Session files. Provided context is optional recorded session data; the UI does not compile new context or infer that delivered information was read. The demo supplies simulated records. Production capture of these records is not yet wired.
