# 릴리스 체크리스트

1. `lightboard_illust_status.js`의 `//@version`을 이전 GitHub 공개 버전보다 높입니다.
2. `//@update-url`이 `lbh848/LB_plugin/main/lightboard_illust_status.js`를 가리키는지 확인합니다.
3. PowerShell에서 `./verify.ps1`을 실행합니다.
4. RisuAI에서 개발 파일을 직접 import하여 자동 생성, 수동 답장 메뉴, 전체·개별 생성, `에셋만 리롤`의 일반 삽화 보존·에셋 위치 재선택·Comfy 미진입, 정적 이미지의 `편하게 수정` 노출과 애니메이션 이미지의 편집 차단, 모든 이미지의 서버 원본/PNG fallback, 만료된 서버 URL에서 일반 장면과 KEYVISUAL 인라인·전체화면의 fallback 위 엑박 아이콘이 숨겨지는지, 정상 KEYVISUAL PNG/GIF/animated AVIF/WebP가 흐림·확대·조각남 없이 표시되고 애니메이션이 진행하는지, animated 전용 eager/sync와 버전 URL의 1시간 private 캐시, 대시보드 입력을 확인합니다.
5. 변경 내용을 commit하고 `main`에 push합니다.
6. raw URL의 앞 512바이트에 새 버전이 반영됐는지 확인합니다.
7. 기존 설치본에서 업데이트 확인 후 녹색 `+`가 나타나고 업데이트되는지 확인합니다.

최초 push 예시:

```powershell
git add .
git commit -m "Prepare LightBoard plugin online updates"
git remote add origin https://github.com/lbh848/LB_plugin.git
git push -u origin main
```

후속 릴리스 예시:

```powershell
./verify.ps1
git add lightboard_illust_status.js
git commit -m "Release plugin 42.0.6"
git push
```

GitHub 웹 화면으로 파일을 올려도 되지만, 배포 경로와 파일명을 유지해야 합니다. 저장소나 브랜치 이름을 바꿨다면 이미 설치된 플러그인은 예전 URL을 계속 바라보므로 먼저 호환용 파일을 남겨야 합니다.
