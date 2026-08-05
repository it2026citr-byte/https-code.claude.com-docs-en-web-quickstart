#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Собирает Template.xml (схема компоновки данных) из текста запроса.

Структура повторяет образец "ПРИМЕР.xlsx":
  ПРОГНОЗ — заказы в статусе "Формируется": основание -> заказ на производство;
  ПЛАН    — заказы в статусе "К производству": основание -> заказ -> этап,
            план на уровне заказа, факт на уровне каждого этапа.

Запрос — единственный источник правды: src/Запросы/ЗапросОтчета.txt.
После правки запроса перезапустить:  python3 tools/gen_schema.py
"""
import html
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
QUERY = ROOT / "src" / "Запросы" / "ЗапросОтчета.txt"
OUT = (ROOT / "src" / "ГантПоЗаказамНаПроизводство" / "Templates"
       / "ОсновнаяСхемаКомпоновкиДанных" / "Ext" / "Template.xml")

# поле набора данных -> заголовок (заголовки — как в образце)
FIELDS = [
    ("ДокументОснование", "Документ-основание"),
    ("Заказ", "Заказ на производство"),
    ("Номер", "Номер"),
    ("ДатаДокумента", "Дата документа"),
    ("Статус", "Статус"),
    ("Подразделение", "Подразделение"),
    ("Этап", "Этап производства"),
    ("ВидИнтервала", "Вид интервала"),
    ("ПорядокВида", "Порядок вида"),
    ("ДатаНачала", "Дата начала интервала"),
    ("ДатаОкончания", "Дата окончания интервала"),
    ("НачатьНеРанее", "Начать не ранее (заказ на производство)"),
    ("ЖелаемаяДатаВыпуска", "Желаемая дата выпуска (заказ на производство)"),
    ("СрокИзготовленияДней", "Срок изготовления, к дней"),
    ("НачатФакт", "Начат (факт. начало этапа)"),
    ("ЗавершенФакт", "Завершен (факт. окончание этапа)"),
    ("ЭтоФакт", "Это факт"),
]

# ресурсы: диаграмма Ганта берёт значения точек только из ресурсов
RESOURCES = [
    ("ДатаНачала", "Минимум(ДатаНачала)"),
    ("ДатаОкончания", "Максимум(ДатаОкончания)"),
    ("НачатьНеРанее", "Минимум(НачатьНеРанее)"),
    ("ЖелаемаяДатаВыпуска", "Максимум(ЖелаемаяДатаВыпуска)"),
    ("СрокИзготовленияДней", "Максимум(СрокИзготовленияДней)"),
    ("НачатФакт", "Минимум(НачатФакт)"),
    ("ЗавершенФакт", "Максимум(ЗавершенФакт)"),
    ("ДлительностьДней", "Максимум(ДлительностьДней)"),
]

CALCULATED = [
    ("ДлительностьДней", 'РазностьДат(ДатаНачала, ДатаОкончания, "ДЕНЬ")',
     "Длительность, дней"),
]

STATUS_TYPE = "ПеречислениеСсылка.СтатусыЗаказовНаПроизводство2_5"


def loc(text, ns="v8"):
    return (f'<{ns}:item><{ns}:lang>ru</{ns}:lang>'
            f'<{ns}:content>{html.escape(text)}</{ns}:content></{ns}:item>')


def dataset_fields():
    return "\n".join(
        '\t\t<field xsi:type="DataSetFieldField">\n'
        f'\t\t\t<dataPath>{name}</dataPath>\n'
        f'\t\t\t<field>{name}</field>\n'
        f'\t\t\t<title xsi:type="v8:LocalStringType">{loc(title)}</title>\n'
        '\t\t</field>'
        for name, title in FIELDS)


def calculated_fields():
    return "\n".join(
        '\t<calculatedField>\n'
        f'\t\t<dataPath>{path}</dataPath>\n'
        f'\t\t<expression>{html.escape(expr)}</expression>\n'
        f'\t\t<title xsi:type="v8:LocalStringType">{loc(title)}</title>\n'
        '\t</calculatedField>'
        for path, expr, title in CALCULATED)


def resources():
    return "\n".join(
        '\t<totalField>\n'
        f'\t\t<dataPath>{path}</dataPath>\n'
        f'\t\t<expression>{html.escape(expr)}</expression>\n'
        '\t</totalField>'
        for path, expr in RESOURCES)


def parameters():
    return f"""\t<parameter>
\t\t<name>СвойствоСрокИзготовления</name>
\t\t<title xsi:type="v8:LocalStringType">{loc('Доп. реквизит "Срок изготовления, к дней"')}</title>
\t\t<valueType>
\t\t\t<v8:Type>cfg:ПланВидовХарактеристикСсылка.ДополнительныеРеквизитыИСведения</v8:Type>
\t\t</valueType>
\t\t<use>Always</use>
\t</parameter>
\t<parameter>
\t\t<name>НачалоПериода</name>
\t\t<title xsi:type="v8:LocalStringType">{loc('Начало периода')}</title>
\t\t<valueType>
\t\t\t<v8:Type>xs:dateTime</v8:Type>
\t\t\t<v8:DateQualifiers>
\t\t\t\t<v8:DateFractions>Date</v8:DateFractions>
\t\t\t</v8:DateQualifiers>
\t\t</valueType>
\t\t<value xsi:type="xs:dateTime">0001-01-01T00:00:00</value>
\t\t<use>Always</use>
\t</parameter>
\t<parameter>
\t\t<name>КонецПериода</name>
\t\t<title xsi:type="v8:LocalStringType">{loc('Конец периода')}</title>
\t\t<valueType>
\t\t\t<v8:Type>xs:dateTime</v8:Type>
\t\t\t<v8:DateQualifiers>
\t\t\t\t<v8:DateFractions>Date</v8:DateFractions>
\t\t\t</v8:DateQualifiers>
\t\t</valueType>
\t\t<value xsi:type="xs:dateTime">0001-01-01T00:00:00</value>
\t\t<use>Always</use>
\t</parameter>
\t<parameter>
\t\t<name>Статусы</name>
\t\t<title xsi:type="v8:LocalStringType">{loc('Статусы заказов')}</title>
\t\t<valueType>
\t\t\t<v8:Type>cfg:{STATUS_TYPE}</v8:Type>
\t\t</valueType>
\t\t<value xsi:type="v8:ValueListType">
\t\t\t<v8:item>
\t\t\t\t<v8:value xsi:type="cfg:{STATUS_TYPE}">Формируется</v8:value>
\t\t\t</v8:item>
\t\t\t<v8:item>
\t\t\t\t<v8:value xsi:type="cfg:{STATUS_TYPE}">КПроизводству</v8:value>
\t\t\t</v8:item>
\t\t</value>
\t\t<use>Always</use>
\t\t<valueListAllowed>true</valueListAllowed>
\t</parameter>"""


def group_item(field, ind):
    t = "\t" * ind
    return (f'{t}<dcsset:item xsi:type="dcsset:GroupItemField">\n'
            f'{t}\t<dcsset:field>{field}</dcsset:field>\n'
            f'{t}\t<dcsset:groupType>Items</dcsset:groupType>\n'
            f'{t}\t<dcsset:periodAdditionType>None</dcsset:periodAdditionType>\n'
            f'{t}\t<dcsset:periodAdditionPeriod xsi:type="xs:dateTime">'
            f'0001-01-01T00:00:00</dcsset:periodAdditionPeriod>\n'
            f'{t}</dcsset:item>')


def group(field, ind, order_field=None, nested=""):
    """Группировка по полю с необязательной вложенной группировкой."""
    t = "\t" * ind
    order = ""
    if order_field:
        order = (f'\n{t}\t<dcsset:order>\n'
                 f'{t}\t\t<dcsset:item xsi:type="dcsset:OrderItemField">\n'
                 f'{t}\t\t\t<dcsset:field>{order_field}</dcsset:field>\n'
                 f'{t}\t\t\t<dcsset:orderType>Asc</dcsset:orderType>\n'
                 f'{t}\t\t</dcsset:item>\n'
                 f'{t}\t</dcsset:order>')
    return (f'{t}<dcsset:item xsi:type="dcsset:StructureItemGroup">\n'
            f'{t}\t<dcsset:groupItems>\n'
            f'{group_item(field, ind + 2)}\n'
            f'{t}\t</dcsset:groupItems>{order}\n'
            f'{t}\t<dcsset:selection>\n'
            f'{t}\t\t<dcsset:item xsi:type="dcsset:SelectedItemAuto"/>\n'
            f'{t}\t</dcsset:selection>\n'
            f'{nested}'
            f'{t}</dcsset:item>')


def chart(status_value, title, with_stages):
    """Диаграмма Ганта.

    Точки  — иерархия: документ-основание -> заказ на производство [-> этап].
    Серии  — План / Факт.
    Значение — два ресурса: начало и окончание интервала (порядок важен).
    """
    if with_stages:
        points = group("ДокументОснование", 5,
                       nested=group("Заказ", 6, order_field="ДатаНачала",
                                    nested=group("Этап", 7,
                                                 order_field="ДатаНачала") + "\n") + "\n")
        series_filter = ""
    else:
        points = group("ДокументОснование", 5,
                       nested=group("Заказ", 6, order_field="ДатаНачала") + "\n")
        # в статусе "Формируется" этапов ещё нет — оставляем только план
        series_filter = """
\t\t\t\t\t<dcsset:filter>
\t\t\t\t\t\t<dcsset:item xsi:type="dcsset:FilterItemComparison">
\t\t\t\t\t\t\t<dcsset:use>true</dcsset:use>
\t\t\t\t\t\t\t<dcsset:left xsi:type="dcscor:Field">ЭтоФакт</dcsset:left>
\t\t\t\t\t\t\t<dcsset:comparisonType>Equal</dcsset:comparisonType>
\t\t\t\t\t\t\t<dcsset:right xsi:type="xs:boolean">false</dcsset:right>
\t\t\t\t\t\t</dcsset:item>
\t\t\t\t\t</dcsset:filter>"""

    return f"""\t\t\t<dcsset:item xsi:type="dcsset:StructureItemChart">
\t\t\t\t<dcsset:outputParameters>
\t\t\t\t\t<dcsset:item xsi:type="dcsset:SettingsParameterValue">
\t\t\t\t\t\t<dcsset:parameter>ТипДиаграммы</dcsset:parameter>
\t\t\t\t\t\t<dcsset:value xsi:type="v8ui:ChartType">GanttChart</dcsset:value>
\t\t\t\t\t</dcsset:item>
\t\t\t\t\t<dcsset:item xsi:type="dcsset:SettingsParameterValue">
\t\t\t\t\t\t<dcsset:parameter>Заголовок</dcsset:parameter>
\t\t\t\t\t\t<dcsset:value xsi:type="v8:LocalStringType">{loc(title)}</dcsset:value>
\t\t\t\t\t</dcsset:item>
\t\t\t\t\t<dcsset:item xsi:type="dcsset:SettingsParameterValue">
\t\t\t\t\t\t<dcsset:parameter>РасположениеЛегенды</dcsset:parameter>
\t\t\t\t\t\t<dcsset:value xsi:type="v8ui:ChartLegendPlacement">Bottom</dcsset:value>
\t\t\t\t\t</dcsset:item>
\t\t\t\t</dcsset:outputParameters>
\t\t\t\t<dcsset:filter>
\t\t\t\t\t<dcsset:item xsi:type="dcsset:FilterItemComparison">
\t\t\t\t\t\t<dcsset:use>true</dcsset:use>
\t\t\t\t\t\t<dcsset:left xsi:type="dcscor:Field">Статус</dcsset:left>
\t\t\t\t\t\t<dcsset:comparisonType>Equal</dcsset:comparisonType>
\t\t\t\t\t\t<dcsset:right xsi:type="cfg:{STATUS_TYPE}">{status_value}</dcsset:right>
\t\t\t\t\t</dcsset:item>
\t\t\t\t</dcsset:filter>
\t\t\t\t<dcsset:point>
{points}
\t\t\t\t</dcsset:point>
\t\t\t\t<dcsset:series>
\t\t\t\t<dcsset:item xsi:type="dcsset:StructureItemGroup">
\t\t\t\t\t<dcsset:groupItems>
{group_item('ВидИнтервала', 6)}
\t\t\t\t\t</dcsset:groupItems>{series_filter}
\t\t\t\t\t<dcsset:order>
\t\t\t\t\t\t<dcsset:item xsi:type="dcsset:OrderItemField">
\t\t\t\t\t\t\t<dcsset:field>ПорядокВида</dcsset:field>
\t\t\t\t\t\t\t<dcsset:orderType>Asc</dcsset:orderType>
\t\t\t\t\t\t</dcsset:item>
\t\t\t\t\t</dcsset:order>
\t\t\t\t\t<dcsset:selection>
\t\t\t\t\t\t<dcsset:item xsi:type="dcsset:SelectedItemAuto"/>
\t\t\t\t\t</dcsset:selection>
\t\t\t\t</dcsset:item>
\t\t\t\t</dcsset:series>
\t\t\t\t<dcsset:selection>
\t\t\t\t\t<dcsset:item xsi:type="dcsset:SelectedItemField">
\t\t\t\t\t\t<dcsset:field>ДатаНачала</dcsset:field>
\t\t\t\t\t</dcsset:item>
\t\t\t\t\t<dcsset:item xsi:type="dcsset:SelectedItemField">
\t\t\t\t\t\t<dcsset:field>ДатаОкончания</dcsset:field>
\t\t\t\t\t</dcsset:item>
\t\t\t\t</dcsset:selection>
\t\t\t</dcsset:item>"""


TABLE_COLUMNS = ["НачатьНеРанее", "НачатФакт", "ЗавершенФакт",
                 "ЖелаемаяДатаВыпуска", "СрокИзготовленияДней",
                 "ДатаНачала", "ДатаОкончания", "ДлительностьДней"]


def selection(fields, ind):
    t = "\t" * ind
    items = "\n".join(
        f'{t}\t<dcsset:item xsi:type="dcsset:SelectedItemField">\n'
        f'{t}\t\t<dcsset:field>{f}</dcsset:field>\n'
        f'{t}\t</dcsset:item>' for f in fields)
    return f'{t}<dcsset:selection>\n{items}\n{t}</dcsset:selection>'


def table(status_value, title, with_stages):
    """Табличная расшифровка под диаграммой — колонки как в образце."""
    if with_stages:
        rows = group("ДокументОснование", 5,
                     nested=group("Заказ", 6, order_field="ДатаНачала",
                                  nested=group("Этап", 7,
                                               order_field="ДатаНачала") + "\n") + "\n")
    else:
        rows = group("ДокументОснование", 5,
                     nested=group("Заказ", 6, order_field="ДатаНачала") + "\n")

    return f"""\t\t\t<dcsset:item xsi:type="dcsset:StructureItemTable">
\t\t\t\t<dcsset:outputParameters>
\t\t\t\t\t<dcsset:item xsi:type="dcsset:SettingsParameterValue">
\t\t\t\t\t\t<dcsset:parameter>Заголовок</dcsset:parameter>
\t\t\t\t\t\t<dcsset:value xsi:type="v8:LocalStringType">{loc(title)}</dcsset:value>
\t\t\t\t\t</dcsset:item>
\t\t\t\t</dcsset:outputParameters>
\t\t\t\t<dcsset:filter>
\t\t\t\t\t<dcsset:item xsi:type="dcsset:FilterItemComparison">
\t\t\t\t\t\t<dcsset:use>true</dcsset:use>
\t\t\t\t\t\t<dcsset:left xsi:type="dcscor:Field">Статус</dcsset:left>
\t\t\t\t\t\t<dcsset:comparisonType>Equal</dcsset:comparisonType>
\t\t\t\t\t\t<dcsset:right xsi:type="cfg:{STATUS_TYPE}">{status_value}</dcsset:right>
\t\t\t\t\t</dcsset:item>
\t\t\t\t</dcsset:filter>
\t\t\t\t<dcsset:row>
{rows}
\t\t\t\t</dcsset:row>
{selection(TABLE_COLUMNS, 4)}
\t\t\t</dcsset:item>"""


def build():
    query = QUERY.read_text(encoding="utf-8")
    xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<DataCompositionSchema xmlns="http://v8.1c.ru/8.1/data-composition-system/schema" xmlns:cfg="http://v8.1c.ru/8.1/data/enterprise/current-config" xmlns:dcscor="http://v8.1c.ru/8.1/data-composition-system/core" xmlns:dcsset="http://v8.1c.ru/8.1/data-composition-system/settings" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:v8ui="http://v8.1c.ru/8.1/data/ui" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
\t<dataSource>
\t\t<name>ИсточникДанных1</name>
\t\t<dataSourceType>Local</dataSourceType>
\t</dataSource>
\t<dataSet xsi:type="DataSetQuery">
\t\t<name>ЗаказыНаПроизводство</name>
{dataset_fields()}
\t\t<dataSource>ИсточникДанных1</dataSource>
\t\t<query>{html.escape(query)}</query>
\t</dataSet>
{calculated_fields()}
{resources()}
{parameters()}
\t<settingsVariant>
\t\t<dcsset:name>ПрогнозИПлан</dcsset:name>
\t\t<dcsset:presentation xsi:type="v8:LocalStringType">{loc('Прогноз и план производства')}</dcsset:presentation>
\t\t<dcsset:settings xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
\t\t\t<dcsset:selection>
\t\t\t\t<dcsset:item xsi:type="dcsset:SelectedItemAuto"/>
\t\t\t</dcsset:selection>
{chart('Формируется', 'ПРОГНОЗ. Статус заказа «Формируется»', False)}
{table('Формируется', 'ПРОГНОЗ. Статус заказа «Формируется»', False)}
{chart('КПроизводству', 'ПЛАН. Статус заказа «К производству»', True)}
{table('КПроизводству', 'ПЛАН. Статус заказа «К производству»', True)}
\t\t\t<dcsset:outputParameters>
\t\t\t\t<dcsset:item xsi:type="dcsset:SettingsParameterValue">
\t\t\t\t\t<dcsset:parameter>ВыводитьПараметрыДанных</dcsset:parameter>
\t\t\t\t\t<dcsset:value xsi:type="dcscor:DataCompositionTextOutputType">Auto</dcsset:value>
\t\t\t\t</dcsset:item>
\t\t\t</dcsset:outputParameters>
\t\t</dcsset:settings>
\t</settingsVariant>
</DataCompositionSchema>
"""
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(xml, encoding="utf-8")
    print(f"written: {OUT.relative_to(ROOT)}  ({len(xml)} bytes)")


if __name__ == "__main__":
    build()
