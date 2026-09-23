#!/usr/bin/env python3
"""生成或原地修改 XLSX 工作簿。

新建工作簿：
  {"sheets": [{"name": "数据", "rows": [["项目", "数值"], ["示例", 1]]}]}

在既有工作簿上修改（source 为既有文件路径）：
  {"source": "既有.xlsx", "sheets": [{"name": "数据", "mode": "append", "rows": [["库存", 7]]}]}

sheets[].mode：append（默认，追加到该表末尾，表不存在时新建）/ replace（覆盖该表内容）。
"""
import json
import sys
from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font


def format_sheet(sheet):
    if sheet.max_row:
        for cell in sheet[1]:
            cell.font = Font(bold=True)
    for column in sheet.columns:
        width = min(max((len(str(cell.value or "")) for cell in column), default=8) + 2, 60)
        sheet.column_dimensions[column[0].column_letter].width = width


def main():
    if len(sys.argv) != 3:
        raise SystemExit("用法: cnpc-excel.py input.json output.xlsx")
    with open(sys.argv[1], encoding="utf-8") as stream:
        data = json.load(stream)
    source = data.get("source")
    if source:
        workbook = load_workbook(source)
    else:
        workbook = Workbook()
        workbook.remove(workbook.active)
    for sheet_data in data.get("sheets", []):
        name = str(sheet_data.get("name", "Sheet"))[:31]
        mode = sheet_data.get("mode", "append")
        if mode not in ("append", "replace"):
            raise SystemExit("mode 只支持 append 或 replace，当前为: %s" % mode)
        if mode == "replace" and name in workbook.sheetnames:
            del workbook[name]
        sheet = workbook[name] if name in workbook.sheetnames else workbook.create_sheet(name)
        for row in sheet_data.get("rows", []):
            sheet.append(list(row))
        format_sheet(sheet)
    if not workbook.sheetnames:
        workbook.create_sheet("Sheet1")
    workbook.save(sys.argv[2])


if __name__ == "__main__":
    main()
