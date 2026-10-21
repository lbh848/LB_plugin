# 릴리스 체크리스트

v69 배포 전에는 `node module/test_v69_image_recovery.cjs --pocketrisu`도 실행합니다. 서버 원본 실패 시 저장본을 클릭해 확대·닫기, KEYVISUAL·일반 삽화·애니메이션 에셋, 같은 media와 fallback 토큰 한 개 유지, 빈 후보·드롭·제거된 슬롯 제외, 원본 에셋 보존, 정상 RAW 생성과 실패 후 기존 채팅 보존을 확인합니다. v69 모듈은 별도로 import해야 하며 플러그인 온라인 업데이트만으로 교체되지 않습니다.

1. `lightboard_illust_status.js`의 `//@version`을 이전 GitHub 공개 버전보다 높입니다.
2. `//@update-url`이 `lbh848/LB_plugin/main/lightboard_illust_status.js`를 가리키는지 확인합니다.
3. PowerShell에서 `./verify.ps1`을 실행합니다.
4. RisuAI에서 개발 파일을 직접 import하여 XML 노드 제거의 기본 켜기·끄기·`OUTPUT만 보존`에서 CHAT 정리와 래퍼 본문 문단 슬롯, 저장 원문 보존, 긴 단일 문단이 앞뒤에 있고 빈 줄이 중간에 몰린 응답의 전체 길이 슬롯 분포, 이어지는 다문장 대사·생각·독백 내부 슬롯 차단과 완결된 발화 뒤 슬롯 허용, 정상 문단 응답의 기존 슬롯 순서, 자동 생성, 수동 답장 메뉴, 전체·개별 생성, `에셋만 리롤`의 일반 삽화 보존·에셋 위치 재선택·Comfy 미진입, 정적 이미지의 `편하게 수정` 노출과 애니메이션 이미지의 편집 차단, 모든 이미지의 서버 원본/PNG fallback, 만료된 서버 URL에서 일반 장면과 KEYVISUAL 인라인·전체화면의 fallback 위 엑박 아이콘이 숨겨지는지, 정상 KEYVISUAL PNG/GIF/animated AVIF/WebP가 흐림·확대·조각남 없이 표시되고 애니메이션이 진행하는지, animated 전용 eager/sync와 버전 URL의 1시간 private 캐시, 대시보드 입력을 확인합니다.
5. 변경 내용을 commit하고 `main`에 push합니다.
6. raw URL의 앞 512바이트에 새 버전이 반영됐는지 확인합니다.
7. 기존 설치본에서 업데이트 확인 후 녹색 `+`가 나타나고 업데이트되는지 확인합니다.

모듈 v62의 표시 회귀 확인에는 에셋과 일반 삽화를 함께 배치한 채 각자의 원본/고정 비율과 서로 다른 최대 너비를 적용합니다. 서버 원본이 먼저 로딩될 때, Risu 저장본이 먼저 로딩될 때, 어느 한쪽이 실패할 때 다음 이미지나 본문을 침범하지 않는지 확인합니다. 로딩 완료 후 크기·정렬과 KEYVISUAL·전체화면 표시도 이전 버전과 비교합니다.

모듈 v67에서는 한 메시지에 `# Response`·`# 응답`·`# 応答` 제목이 여러 번 있고 이미지가 각 구간에 있는 기존 채팅을 확인합니다. 모든 삽화 wrapper와 툴바가 유지되고, 각 Risu fallback 토큰이 인라인 본문에 정확히 한 번만 있으며, 확대보기 dialog 안에는 fallback 복제본이 없어야 합니다. 캐시되지 않은 inlay가 블록 placeholder로 바뀐 상태에서도 이미지가 연속 두 장으로 나오거나 래퍼 밖으로 이탈하면 안 됩니다. KEYVISUAL 1개와 일반 장면 여러 개, 기존 v66 span 마크업과 신규 div 마크업을 함께 확인하며 이미지 재생성은 필요하지 않습니다.

모듈 v66 회귀에서는 같은 이미지의 fallback `</span>`과 서버 `<img>` 사이에 빈 줄이 있는 기존 채팅도 확인합니다. 마크다운이 이미지 내부에 `<p>`를 끼워 넣지 않고 두 레이어가 같은 칸에 겹쳐져야 합니다. 배경 스타일이 늦게 적용되는 동안에도 종류별 너비·비율·정렬이 유지되어야 하며, 이미지를 사이에 둔 본문 문단, 인접 슬롯, 모바일 너비, 로컬 fallback 및 확대 보기·KEYVISUAL을 함께 확인합니다.

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
