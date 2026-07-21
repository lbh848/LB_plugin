# LightBoard 호환 백엔드 스냅샷

이 폴더는 다음 RisuAI 모듈과 호환되는 `comfyui_hooking_server` 실행 소스입니다.

- `라이트보드  삽화 3.4.1-soya-v42.module.charx`
- `🔦라이트보드 - 3.4.0-soya-0704.module.charx`

기준 저장소는 `https://github.com/lbh848/comfyui_hooking_server`이며, 기준 commit `7c6e00d`의 추적 파일에 v42 호환 작업 트리 변경을 포함한 스냅샷입니다.

## v42 호환 변경이 포함된 핵심 파일

- `server.py`
- `modes/illustration_context_pipeline.py`
- `tests/test_illustration_context_pipeline.py`

v42는 24자 조회 키와 `GET /s/{key}`를 사용해 서버가 확정한 실제 슬롯 배열만 모듈에서 회수합니다. 이미지는 계속 Risu의 `generateImage(..., 'inlay')` 경로로 전달되며 플러그인이 이미지를 직접 받지 않습니다.

## 의도적으로 제외한 항목

- 원본 서버 저장소의 `.git/`
- `.venv/`, `__pycache__/`, 테스트 캐시
- 개인 `config.json`, `.env`, 키와 알림 캐시
- `asset/`, `models/`, `logs/`, 세션 및 생성 결과
- 개발 도구의 로컬 작업 상태 파일

기존 서버를 교체할 때 개인 설정과 데이터는 별도로 백업하십시오. 이 스냅샷에 개인 설정 파일을 덮어 넣은 뒤 Git에 commit하지 않도록 주의하십시오.
