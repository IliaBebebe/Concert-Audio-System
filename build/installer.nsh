; CAS installer presentation. Keep electron-builder's install/update/uninstall logic.
; Use native controls and dialog units so keyboard access and DPI scaling survive.

!define MUI_BGCOLOR "FFFFFF"
!define MUI_TEXTCOLOR "20242C"
!define MUI_INSTFILESPAGE_COLORS "475569 F7F8FA"
!define MUI_INSTFILESPAGE_PROGRESSBAR "smooth"
!define MUI_WELCOMEFINISHPAGE_BITMAP_STRETCH "FitControl"
!define MUI_UNWELCOMEFINISHPAGE_BITMAP_STRETCH "FitControl"
SetFont "Segoe UI" 10

Var casWelcomeTitle
Var casWelcomeText
Var casFinishTitle
Var casFinishText
Var casRunText
Var casUnWelcomeTitle
Var casUnWelcomeText
Var casUnFinishTitle
Var casUnFinishText
Var casTitleFont

; Preserve all bundled NSIS languages. New copy falls back to English;
; standard pages continue to use electron-builder's existing translations.
!macro casSetCopy
  StrCpy $casWelcomeTitle "Your sound.$\r$\nYour stage."
  StrCpy $casWelcomeText "Concert Audio System ${VERSION}$\r$\n$\r$\nMusic, transitions and sound cues for your events.$\r$\n$\r$\nChoose where to install CAS. Add your music library when you first open the app."
  StrCpy $casFinishTitle "CAS is installed.$\r$\nTake the controls."
  StrCpy $casFinishText "Your workspace is ready.$\r$\n$\r$\nOpen CAS and choose your music folder to get started."
  StrCpy $casRunText "Open Concert Audio System"
  StrCpy $casUnWelcomeTitle "Uninstall CAS"
  StrCpy $casUnWelcomeText "This wizard will remove Concert Audio System from your computer.$\r$\n$\r$\nYour music folders and saved app settings will be kept."
  StrCpy $casUnFinishTitle "CAS is uninstalled."
  StrCpy $casUnFinishText "Concert Audio System has been removed from your computer.$\r$\n$\r$\nYou can close this wizard."
  ${If} $LANGUAGE == 1049
    StrCpy $casWelcomeTitle "Ваш звук.$\r$\nВаша сцена."
    StrCpy $casWelcomeText "Concert Audio System ${VERSION}$\r$\n$\r$\nМузыка, переходы и звуковые эффекты для ваших мероприятий.$\r$\n$\r$\nВыберите, куда установить CAS. Свою папку с музыкой вы добавите при первом запуске."
    StrCpy $casFinishTitle "CAS установлен.$\r$\nМожно начинать."
    StrCpy $casFinishText "Рабочее пространство готово.$\r$\n$\r$\nОткройте CAS и выберите папку с музыкой, чтобы начать работу."
    StrCpy $casRunText "Открыть Concert Audio System"
    StrCpy $casUnWelcomeTitle "Удаление CAS"
    StrCpy $casUnWelcomeText "Мастер удалит Concert Audio System с компьютера.$\r$\n$\r$\nВаши музыкальные папки и сохранённые настройки приложения останутся на месте."
    StrCpy $casUnFinishTitle "CAS удалён."
    StrCpy $casUnFinishText "Concert Audio System удалён с компьютера.$\r$\n$\r$\nМастер можно закрыть."
  ${EndIf}
!macroend

!macro customInit
  !insertmacro casSetCopy
!macroend

!macro customUnInit
  !insertmacro casSetCopy
!macroend

!macro customHeader
  BrandingText "Concert Audio System ${VERSION}"
  ; All MUI page variables exist here, after assistedInstaller.nsh is parsed.
  !ifdef BUILD_UNINSTALLER
    !insertmacro casWelcomeStyle "un."
    !insertmacro casFinishStyle "un."
  !else
    !insertmacro casWelcomeStyle ""
    !insertmacro casFinishStyle ""
  !endif
!macroend

!macro casWelcomeStyle PREFIX
  Function ${PREFIX}casWelcomeShow
    CreateFont $casTitleFont "Segoe UI" 16 700
    SendMessage $mui.WelcomePage.Title ${WM_SETFONT} $casTitleFont 1
    SetCtlColors $mui.WelcomePage.Text "596273" "FFFFFF"
  FunctionEnd
!macroend

!macro casFinishStyle PREFIX
  Function ${PREFIX}casFinishShow
    CreateFont $casTitleFont "Segoe UI" 16 700
    SendMessage $mui.FinishPage.Title ${WM_SETFONT} $casTitleFont 1
    SetCtlColors $mui.FinishPage.Text "596273" "FFFFFF"
  FunctionEnd
!macroend

!macro customWelcomePage
  !insertmacro skipPageIfUpdated
  !define MUI_WELCOMEPAGE_TITLE "$casWelcomeTitle"
  !define MUI_WELCOMEPAGE_TEXT "$casWelcomeText"
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW casWelcomeShow
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customFinishPage
  ; Match the stock launch behavior, including silent update arguments and UAC.
  !ifndef HIDE_RUN_AFTER_FINISH
    Function casStartApp
      ${If} ${isUpdated}
        StrCpy $1 "--updated"
      ${Else}
        StrCpy $1 ""
      ${EndIf}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
    FunctionEnd
    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_FUNCTION "casStartApp"
    !define MUI_FINISHPAGE_RUN_TEXT "$casRunText"
  !endif
  !define MUI_FINISHPAGE_TITLE "$casFinishTitle"
  !define MUI_FINISHPAGE_TEXT "$casFinishText"
  !define MUI_FINISHPAGE_TEXT_LARGE
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW casFinishShow
  !insertmacro MUI_PAGE_FINISH
!macroend

!macro customUnWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "$casUnWelcomeTitle"
  !define MUI_WELCOMEPAGE_TEXT "$casUnWelcomeText"
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.casWelcomeShow
  !insertmacro MUI_UNPAGE_WELCOME
!macroend

!macro customUninstallPage
  !define MUI_FINISHPAGE_TITLE "$casUnFinishTitle"
  !define MUI_FINISHPAGE_TEXT "$casUnFinishText"
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.casFinishShow
!macroend
