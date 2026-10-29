# MCP Registry 등록 준비(T178)

공식 MCP Registry(`registry.modelcontextprotocol.io`)에 DUO MCP 서버를 올리기 위한 메타데이터다. **등록(publish)은 하지 않았다.** 실제 등록은 maintainer의 별도 승인 대상이며, `mcpName`이 들어간 version이 npm에 먼저 게시돼야 한다.

## 파일

| 파일 | 내용 |
|---|---|
| [`server.json`](../../server.json) | Registry에 보낼 서버 정보. schema `2025-12-11`. 이름 `io.github.kanghyunsoon/duo`, npm package `@duo-director/cli`, `runtimeHint: npx`, stdio, 인자 `mcp --root-from git-cwd` |
| `apps/cli/package.json` `mcpName` | Registry의 npm 소유권 확인용. `server.json`의 `name`과 같아야 한다. `scripts/pack-cli.mjs`가 게시 package.json에 그대로 옮긴다 |
| `tests/workspace/mcp-registry.test.ts` | 이름·version·package·인자·설명 길이(100자)가 맞는지 검사 |
| `tests/distribution/dist.e2e.test.ts` | pack한 package.json의 `mcpName`이 `server.json`의 `name`과 같은지 검사 |

## 이름과 소유권

- 이름은 GitHub namespace `io.github.<user>/<name>`이다. Registry는 GitHub로 로그인한 계정 `kanghyunsoon`에게 `io.github.kanghyunsoon/*`를 허용한다.
- npm 소유권은 게시된 package.json의 `mcpName`으로 확인한다. 0.3.5 이하와 0.4.0-rc.1 패키지에는 `mcpName`이 없으므로 등록할 수 없다. 이 변경이 들어간 다음 version부터 등록할 수 있다.
- npm registry는 `https://registry.npmjs.org`만 허용된다.

## 사용자가 알아야 할 것

- Registry로 서버를 추가해도 DUO가 바로 동작하지 않는다. 저장소마다 `duoctl init`(Truth, index, adoption baseline)이 필요하고, Node.js 24.15 이상이 필요하다.
- 클라이언트는 저장소 안에서 서버를 실행해야 한다. `--root-from git-cwd`가 작업 디렉터리를 포함한 Git work tree의 top level을 root로 쓴다. Codex·Claude Code는 `duoctl install`이 같은 방식으로 설정하고 검증한다. 다른 클라이언트는 DUO가 설정하거나 검증하지 않는다.
- 설명(100자)은 기능 범위를 넘지 않게 쓴다: 사람이 확정한 Decision에 대해 agent 변경을 검토한다.

## Version 규칙

`server.json`의 `version`과 `packages[0].version`은 `apps/cli/package.json`의 version과 같아야 한다(테스트가 검사). Release에서 version을 올릴 때 `server.json`도 함께 고친다.

## 등록 절차(승인 뒤, 실행하지 않음)

1. `mcpName`이 들어간 version을 기존 release 절차로 npm에 게시한다(Human Decision, release gate).
2. `mcp-publisher login github`(maintainer 계정)
3. 저장소 root에서 `mcp-publisher publish`
4. `https://registry.modelcontextprotocol.io/v0/servers?search=io.github.kanghyunsoon/duo`로 결과를 확인한다.

근거: [registry 문서](https://github.com/modelcontextprotocol/registry/tree/main/docs), [official registry requirements](https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/server-json/official-registry-requirements.md), [package types](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/package-types.mdx).
