# LB_plugin 작업 지침

이 저장소에서 작업할 때는 먼저 `AGENTS.md`의 전체 지침을 따른다.

## 버전 업 규칙

- 새 배포마다 `lightboard_illust_status.js`의 `//@version`을 증가시킨다.
- 플러그인 표시 버전도 함께 증가시킨다. 예: `soya comfy manager plugin v1.0.1` → `soya comfy manager plugin v1.0.2`.
- 대시보드 제목은 플러그인 표시 버전과 동일하게 맞춘다. 예: `soya comfy manager v1.0.1` → `soya comfy manager v1.0.2`.
- 대시보드의 `v42.x.x` 표시는 `//@version`과 정확히 일치시킨다. 예: `//@version 42.0.9`이면 대시보드도 `v42.0.9`여야 한다.
- 모듈 내용이 변경되면 `soya-vNN` 번호를 다음 정수로 증가시키고 새 파일로 배포한다. 예: 변경 전 `module/라이트보드  삽화 3.4.1-soya-v42.module.charx` → 변경 후 `module/라이트보드  삽화 3.4.1-soya-v43.module.charx`.
- 변경본을 이전 모듈 파일에 덮어쓰지 않는다. 파일명과 모듈 내부 버전 식별자를 일치시키고, 새 파일을 `verify.ps1`의 검증 대상에 반영한다.

## 백엔드 작업 위치

- 백엔드 소스는 이 저장소에 포함하지 않으며 `backend/` 디렉터리를 만들지 않는다.
- 백엔드 확인 또는 수정이 필요하면 `E:\test3\comfyui_hooking_server`를 작업 대상으로 사용한다.
- 서버를 수정할 때도 플러그인의 역할을 설정, 신호 송수신, 서버 상태 표시 범위로 유지한다.
