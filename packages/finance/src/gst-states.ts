// GST state codes (roadmap v2.1 A8 · CGST Rule 46 · OB-271). A GSTIN begins with the two-digit code of the State or Union
// Territory it is registered in, and a tax invoice names the place of supply by the State's NAME and its code. For an
// over-the-counter sale the place of supply is where the goods are handed over — the store's own State — so the shop's
// GSTIN alone says it and nothing is typed twice.
//
// The list is the GST system's state-code table. Code 25 (Daman and Diu) was merged into 26 in 2020 and is kept so an
// older registration still reads; 97 is "Other Territory". Pure data.

/** The GST system's two-digit state code → the State or Union Territory's name, as the invoice prints it. */
export const GST_STATE_NAMES: Readonly<Record<string, string>> = Object.freeze({
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand',
  '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim',
  '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya',
  '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh',
  '24': 'Gujarat', '25': 'Daman and Diu', '26': 'Dadra and Nagar Haveli and Daman and Diu', '27': 'Maharashtra',
  '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh', '97': 'Other Territory',
});

/** The State a GSTIN is registered in — its code and name — or `undefined` when the first two characters are not a code. */
export function gstStateOf(gstin: string): { readonly code: string; readonly name: string } | undefined {
  const code = gstin.trim().slice(0, 2);
  const name = Object.hasOwn(GST_STATE_NAMES, code) ? GST_STATE_NAMES[code] : undefined;
  return name === undefined ? undefined : { code, name };
}
