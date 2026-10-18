// Public surface of @sre/withholding — income-tax TDS on supplier payments (R3 · A24 · ss.194C/194I/194J), built switched
// off (OB-143 "A"): the CA's payee / section / rate list (empty until filled), the deduction a payment carries, the net the
// payee is paid, the liability until a challan, and the quarterly 26Q summary.

export * from './tds';
