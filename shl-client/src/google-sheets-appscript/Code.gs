function onOpen() {
  SpreadsheetApp.getUi() // Or DocumentApp or SlidesApp or FormApp.
    .createMenu("SMART Health Links")
    .addItem("Get Vaccination Records", "showSidebarConnect")
    .addItem("Refresh Vaccination Records", "showSidebarRetrieve")
    .addToUi();
}

function showSidebarConnect() {
  const template = HtmlService.createTemplateFromFile("Page");
  template.clientName = shlClientName();
  template.shl = SpreadsheetApp.getActive()
    .getActiveSheet()
    .getActiveCell()
    .getValue();
  template.state = "";

  var html = template.evaluate().setTitle("SMART Health Link: Connect");
  SpreadsheetApp.getUi() // Or DocumentApp or SlidesApp or FormApp.
    .showSidebar(html);
}

function showSidebarRetrieve() {
  const template = HtmlService.createTemplateFromFile("Page");
  template.clientName = shlClientName();
  template.shl = "";

  if (
    SpreadsheetApp.getActive()
      .getActiveSheet()
      .getActiveCell()
      .getRichTextValue()
      .getRuns().length == 1
  ) {
    template.state = SpreadsheetApp.getActive()
      .getActiveSheet()
      .getActiveCell()
      .getValue()
      .split("refresh")[1];
  } else {
    template.state = SpreadsheetApp.getActive()
      .getActiveSheet()
      .getActiveCell()
      .getRichTextValue()
      .getRuns()[1]
      .getText();
  }

  var html = template
    .evaluate()
    .setTitle("SMART Health Link: Connect: Refresh");
  SpreadsheetApp.getUi() // Or DocumentApp or SlidesApp or FormApp.
    .showSidebar(html);
}

function returnStateLink(stateLink, shcMessage) {
  const message = `⟳ To update: click here, then "SMART Health Links > Refresh`;
  const bold = SpreadsheetApp.newTextStyle().setBold(true).build();
  const hidden = SpreadsheetApp.newTextStyle()
    .setForegroundColor("white")
    .build();
  const value = SpreadsheetApp.newRichTextValue()
    .setText(message + stateLink)
    .setTextStyle(0, message.length, bold)
    .setTextStyle(message.length, message.length + stateLink.length, hidden)
    .build();

  SpreadsheetApp.getActive()
    .getActiveSheet()
    .getActiveCell()
    .setRichTextValue(value);
  const currCell = SpreadsheetApp.getActive().getActiveSheet().getActiveCell();
  const currRow = currCell.getRow();
  const currCol = currCell.getColumn();

  let nextCell;

  nextCell = SpreadsheetApp.getActive()
    .getActiveSheet()
    .getRange(currRow + 1, currCol);
  nextCell.setValue(
    "Refreshed at " +
      new Date().toLocaleString() +
      ". " +
      JSON.stringify(shcMessage)
  );

  // {"mmrv":2,"hepb":3,"flu":5,"dtap":5,"hepa":2,"pcv":4,"rotavirus":3,"ipv":4,"hib":4}
  nextCell = SpreadsheetApp.getActive()
    .getActiveSheet()
    .getRange(currRow, currCol + 1);
  nextCell.setValue(shcMessage.dtap);

  nextCell = SpreadsheetApp.getActive()
    .getActiveSheet()
    .getRange(currRow, currCol + 2);
  nextCell.setValue(shcMessage.pcv);

  nextCell = SpreadsheetApp.getActive()
    .getActiveSheet()
    .getRange(currRow, currCol + 3);
  nextCell.setValue(shcMessage.ipv);

  nextCell = SpreadsheetApp.getActive()
    .getActiveSheet()
    .getRange(currRow, currCol + 4);
  nextCell.setValue(shcMessage.hib);

  nextCell = SpreadsheetApp.getActive()
    .getActiveSheet()
    .getRange(currRow, currCol + 5);
  nextCell.setValue(shcMessage.rotavirus);

  nextCell = SpreadsheetApp.getActive()
    .getActiveSheet()
    .getRange(currRow, currCol + 6);
  nextCell.setValue(shcMessage.hepb);
}

function shlClientName() {
  const range =
    SpreadsheetApp.getActiveSpreadsheet().getRangeByName("shl_client_name");
  if (range != null) {
    return range.getCell(1, 1).getValue();
  }
  return "Unknown SHL Client";
}
