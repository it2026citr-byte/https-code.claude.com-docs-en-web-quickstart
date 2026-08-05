@echo off
chcp 866 >nul
setlocal enabledelayedexpansion

rem ============================================================
rem  Сборка внешнего отчёта "Гант по заказам на производство"
rem  Запускать на машине с установленной платформой 1С:Предприятие 8.3
rem
rem  Использование:
rem    build_erf.bat "C:\bases\erp_copy2" Администратор [пароль]
rem    build_erf.bat "Srvr=server;Ref=erp_copy2;" Администратор [пароль]
rem ============================================================

set "SRC=%~dp0..\src\ГантПоЗаказамНаПроизводство.xml"
set "OUT=%~dp0ГантПоЗаказамНаПроизводство.erf"
set "LOG=%~dp0build.log"

if "%~1"=="" (
	echo.
	echo   Не указана база.
	echo.
	echo   Файловая база:    build_erf.bat "C:\bases\erp_copy2" Администратор
	echo   Клиент-сервер:    build_erf.bat "Srvr=server;Ref=erp_copy2;" Администратор пароль
	echo.
	exit /b 1
)

rem --- поиск платформы: берём самую свежую версию ---
set "V8="
for /f "delims=" %%D in ('dir /b /o-n "%ProgramFiles%\1cv8\8.3*" 2^>nul') do (
	if not defined V8 if exist "%ProgramFiles%\1cv8\%%D\bin\1cv8.exe" set "V8=%ProgramFiles%\1cv8\%%D\bin\1cv8.exe"
)
if not defined V8 (
	for /f "delims=" %%D in ('dir /b /o-n "%ProgramFiles(x86)%\1cv8\8.3*" 2^>nul') do (
		if not defined V8 if exist "%ProgramFiles(x86)%\1cv8\%%D\bin\1cv8.exe" set "V8=%ProgramFiles(x86)%\1cv8\%%D\bin\1cv8.exe"
	)
)
if not defined V8 (
	echo   Не найден 1cv8.exe. Пропишите путь к нему в переменной V8 внутри этого файла.
	exit /b 1
)

rem --- строка подключения: путь к каталогу или Srvr=... ---
set "CONN=/F"%~1""
echo %~1 | find /i "Srvr=" >nul && set "CONN=/S"%~1""

set "AUTH="
if not "%~2"=="" set "AUTH=/N"%~2""
if not "%~3"=="" set "AUTH=%AUTH% /P"%~3""

if not exist "%SRC%" (
	echo   Не найдены исходники: %SRC%
	echo   Запускайте bat из папки build распакованного архива.
	exit /b 1
)

echo   Платформа : %V8%
echo   База      : %~1
echo   Исходники : %SRC%
echo   Результат : %OUT%
echo.
echo   Сборка...

"%V8%" DESIGNER %CONN% %AUTH% /DisableStartupDialogs /DisableStartupMessages ^
	/LoadExternalDataProcessorOrReportFromFiles "%SRC%" "%OUT%" /Out "%LOG%"

if exist "%OUT%" (
	echo.
	echo   ГОТОВО: %OUT%
	echo   Подключить: НСИ и администрирование - Печатные формы, отчёты и обработки -
	echo               Дополнительные отчёты и обработки, вид "Отчёт", раздел "Производство".
) else (
	echo.
	echo   Сборка не удалась. Лог: %LOG%
	type "%LOG%" 2>nul
	echo.
	echo   Запасной вариант - ручная сборка за 15 минут: docs\02-Сборка-и-настройка.md
)

endlocal
