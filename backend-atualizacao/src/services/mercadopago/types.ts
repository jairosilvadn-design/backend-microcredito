export interface MpTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number; // segundos (hoje ~180 dias)
  scope: string;
  user_id: number;
  refresh_token: string;
  public_key?: string;
  live_mode: boolean;
}

export interface MpFeeDetail {
  type: string; // "application_fee", "mercadopago_fee"...
  amount: number;
  fee_payer?: string;
}

export interface MpPayment {
  id: number;
  status: string; // approved, pending, in_process, rejected, cancelled, refunded, charged_back
  status_detail?: string;
  operation_type?: string;
  payment_method_id?: string;
  payment_type_id?: string;
  transaction_amount: number;
  transaction_details?: { net_received_amount?: number };
  fee_details?: MpFeeDetail[];
  external_reference?: string | null;
  collector_id?: number;
  point_of_interaction?: { type?: string };
  date_created: string;
  date_approved?: string | null;
}

export interface MpPixPaymentResponse extends MpPayment {
  date_of_expiration?: string;
  point_of_interaction?: {
    type?: string;
    transaction_data?: {
      qr_code?: string;        // copia-e-cola (EMV)
      qr_code_base64?: string; // PNG em base64
      ticket_url?: string;     // página do MP com o QR
    };
  };
}

export interface MpPreferenceResponse {
  id: string;
  init_point: string;
  sandbox_init_point?: string;
}
