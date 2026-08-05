@echo off
rem ============================================================================
rem  Откат тестовой базы к эталонному состоянию перед прогоном автотестов.
rem
rem  Зачем: UI-тесты ERP меняют остатки, нумерацию и взаиморасчёты. Без отката
rem  второй прогон даёт другой результат, и тесты начинают "мигать".
rem
rem  Здесь три варианта. Оставьте тот, который подходит вашей инфраструктуре,
rem  остальные удалите.
rem ============================================================================

setlocal

set "V8_BIN=C:\Program Files\1cv8\8.3.24.1548\bin\1cv8.exe"
set "SQL_SERVER=erpdevs"
set "DB=erp_copy2_test"
set "SNAPSHOT=erp_copy2_test_etalon"

rem ---------------------------------------------------------------------------
rem ВАРИАНТ 1 (рекомендуемый): снимок MS SQL Server. Откат за секунды.
rem Снимок создаётся один раз на эталонном состоянии:
rem   CREATE DATABASE erp_copy2_test_etalon ON
rem     (NAME = erp_copy2_test, FILENAME = 'D:\snap\erp_test.ss')
rem     AS SNAPSHOT OF erp_copy2_test;
rem ---------------------------------------------------------------------------

echo [1/2] Отключение сеансов от базы...
sqlcmd -S %SQL_SERVER% -b -Q "ALTER DATABASE [%DB%] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;"
if errorlevel 1 goto :error

echo [2/2] Откат к снимку %SNAPSHOT%...
sqlcmd -S %SQL_SERVER% -b -Q "RESTORE DATABASE [%DB%] FROM DATABASE_SNAPSHOT = '%SNAPSHOT%'; ALTER DATABASE [%DB%] SET MULTI_USER;"
if errorlevel 1 goto :error

echo [OK] База откачена к эталону.
goto :eof

rem ---------------------------------------------------------------------------
rem ВАРИАНТ 2: PostgreSQL — пересоздание из шаблона.
rem
rem   dropdb -h erpdevs -U postgres erp_copy2_test
rem   createdb -h erpdevs -U postgres -T erp_copy2_etalon erp_copy2_test
rem
rem Требует, чтобы к шаблону не было активных подключений.
rem ---------------------------------------------------------------------------

rem ---------------------------------------------------------------------------
rem ВАРИАНТ 3: восстановление из .dt. Самый надёжный и самый медленный
rem (на ERP — от 20 минут до нескольких часов). Только для ночного/недельного
rem полного регресса.
rem
rem   "%V8_BIN%" DESIGNER /S erpdevs\erp_copy2_test /N %ERP_TEST_USER% /P %ERP_TEST_PWD% ^
rem     /RestoreIB "D:\etalon\erp_copy2_etalon.dt" ^
rem     /Out "D:\dump\restore.log" /DisableStartupMessages
rem ---------------------------------------------------------------------------

:error
echo [X] Ошибка отката базы.
exit /b 1
